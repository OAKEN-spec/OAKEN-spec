// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { LockVaultV2 } from "./LockVaultV2.sol";

/**
 * A PinkLock V2 shaped door onto our own vault.
 *
 * ## Why this exists
 *
 * The mirror's create page is PinkSale's compiled front end, and it does not
 * import anything of ours — it holds PinkLock V2's ABI as forty-five
 * human-readable signatures and calls them on whatever address the chain
 * config names as `pinklockV2`. So "make the lock flow actually run" is not a
 * front-end change: it is a translation at the protocol boundary. This
 * contract speaks their interface and stores into `LockVault`.
 *
 * That is deliberately cheaper than the alternatives. Rewriting the bundle's
 * ABI and call sites means touching minified code that has nothing to do with
 * us; changing `LockVault` to look like PinkLock V2 means changing the thing
 * this project is actually about — its addresses move on every bytecode change
 * (see `test/DeterministicDeploy.test.ts`). A bridge is a separate, disposable
 * contract that can be wrong without moving anything else.
 *
 * ## What maps, and what honestly does not
 *
 * PinkLock's model is "tgeBps at tgeDate, then cycleBps every `cycle` days".
 * Ours is "initialUnlockBps at startTime, then the tail in `steps` equal
 * tranches ending at endTime" — the two agree at every boundary when
 * `steps = (10000 - tgeBps) / cycleBps` and the last step lands on `endTime`,
 * which is how `vestingLock` is translated below. `lock` (the non-vesting
 * form) is the degenerate case: everything unlocks at `unlockDate`.
 *
 * Three of their writes **cannot** be forwarded, and revert rather than
 * pretend: `transferLockOwnership`, `renounceLockOwnership` and the two
 * `editLock*` calls all require the vault to see the adapter as the lock's
 * owner or beneficiary, and the locks here belong to the user (the vault's
 * records — and therefore the CLAVIS side of this project — must not say
 * otherwise). Those buttons will error on a lock created this way; that is
 * the honest outcome, not a bug to paper over.
 *
 * `unlock(lockId)` **is** forwardable: claiming is permissionless in the vault
 * (anyone may pay the gas; the tokens go to the beneficiary regardless), which
 * is exactly PinkLock's "withdraw" from the operator's point of view.
 *
 * ## Fees
 *
 * PinkLock V2 charges a creation fee in the chain's native coin for tokens it
 * does not recognize, and the mirrored form prints that fee. This adapter
 * accepts `msg.value` and ignores it — there is no fee here, and reverting on
 * a non-zero value would break the form's own flow. The local chain is play
 * money; a fee that is silently not charged is the smaller lie.
 */
contract PinkLockAdapterV2 {
    LockVaultV2 public immutable vault;

    /// PinkLock's own events, so anything watching them keeps working.
    event LockAdded(uint256 indexed id, address token, address owner, uint256 amount, uint256 unlockDate);
    event LockVested(uint256 indexed id, address token, address owner, uint256 amount, uint256 total, uint256 timestamp);
    event LockRemoved(uint256 indexed id, address token, address owner, uint256 amount, uint256 unlockedAt);

    error Unsupported(string what);
    error UnknownLock(uint256 lockId);
    /// V2: the caller's attached ETH could not be returned.
    error RefundFailed();
    /// V2: reentrant entry while a token callback is running.
    error ReentrantCall();

    /// Per-lock flag the vault does not carry, and per-token / per-owner
    /// indexes the vault does not keep. View functions below are built on these.
    mapping(uint256 => bool) public isLpToken;
    mapping(address => uint256[]) private _idsByToken;
    mapping(address => uint256[]) private _idsByOwner;
    uint256 private _entered;

    constructor(LockVaultV2 vault_) {
        vault = vault_;
    }

    /**
     * The PinkLock tuple, field for field.
     *
     * `unlockedAmount` is our `claimed` — what has actually left the vault —
     * because that is the number PinkLock's `unlockedAmount` drives in their
     * record page. The schedule fields are the same schedule read back out.
     */
    struct PinkLockView {
        uint256 id;
        address token;
        address owner;
        uint256 amount;
        uint256 lockDate;
        uint256 tgeDate;
        uint256 tgeBps;
        uint256 cycle;
        uint256 cycleBps;
        uint256 unlockedAmount;
        string description;
    }

    /**
     * V2: the adapter is a second door into the vault; a token callback can
     * come back through either door. The vault has its own guard; this one
     * keeps the adapter's own indexes and the msg.value refund from re-entering.
     */
    modifier nonReentrant() {
        if (_entered != 0) revert ReentrantCall();
        _entered = 1;
        _;
        _entered = 0;
    }

    /**
     * V2: PinkSale's form may attach the creation fee even though we charge
     * none. v1 accepted the ETH and kept it forever (SR-02). Return it instead
     * and fail loudly if the caller cannot receive it.
     */
    function _refundValue() private {
        uint256 value = msg.value;
        if (value == 0) return;
        (bool ok,) = payable(msg.sender).call{value: value}("");
        if (!ok) revert RefundFailed();
    }

    // ---------------------------------------------------------------- writes

    /**
     * Lock until `unlockDate`, everything released at once.
     *
     * `owner` is the beneficiary in our model; `isLpToken` is recorded but does
     * not change the mechanics — a V2 pair is an ERC-20 and lives in the same
     * vault. (Uniswap V3 *positions* are ERC-721 and belong to `PositionLock`;
     * PinkLock V2's front end cannot reach them, so neither can this.)
     */
    function lock(
        address owner,
        address token,
        bool isLpToken_,
        uint256 amount,
        uint256 unlockDate,
        string calldata description
    ) external payable nonReentrant returns (uint256 id) {
        id = _create(
            owner,
            token,
            isLpToken_,
            amount,
            Schedule({
                startTime: uint64(unlockDate),
                cliffTime: uint64(unlockDate),
                endTime: uint64(unlockDate),
                initialUnlockBps: 0,
                steps: 0
            }),
            description
        );
        emit LockAdded(id, token, owner, amount, unlockDate);
        _refundValue();
    }

    /**
     * `tgeBps` at `tgeDate`, then `cycleBps` every `cycle` days.
     *
     * Translated to our stepped schedule: `steps = tail / cycleBps`, each step
     * releasing `tail / steps`. When `cycleBps` divides the tail evenly the two
     * schedules are identical at every boundary; when it does not, ours ends at
     * the last whole step rather than at a fraction of one — the difference is
     * one cycle of dust and is visible as an `endTime` that lands short.
     */
    function vestingLock(
        address owner,
        address token,
        bool isLpToken_,
        uint256 amount,
        uint256 tgeDate,
        uint256 tgeBps,
        uint256 cycle,
        uint256 cycleBps,
        string calldata description
    ) external payable nonReentrant returns (uint256 id) {
        id = _create(owner, token, isLpToken_, amount, _vestingSchedule(tgeDate, tgeBps, cycle, cycleBps), description);
        emit LockVested(id, token, owner, amount, amount, block.timestamp);
        _refundValue();
    }

    /**
     * Five values is more than `vestingLock` can hold alongside nine calldata
     * arguments and still stay under the stack limit — the same wall the vault
     * hit when `createLock` grew its validation. Computing them here keeps the
     * ten locals off `vestingLock`'s frame. `viaIR` is the other way out and is
     * deliberately not taken: it changes the bytecode of *every* contract in
     * this project, and with it the deterministic addresses.
     */
    function _vestingSchedule(uint256 tgeDate, uint256 tgeBps, uint256 cycle, uint256 cycleBps)
        private
        pure
        returns (Schedule memory)
    {
        if (tgeBps > 10_000 || cycleBps > 10_000) revert Unsupported("bps above 100%");
        uint256 tail = 10_000 - tgeBps;
        uint256 steps = cycleBps == 0 ? 0 : tail / cycleBps;
        return Schedule({
            startTime: uint64(tgeDate),
            cliffTime: uint64(tgeDate),
            /**
             * `cycle` 已经是**秒**，这里**不能再乘 `1 days`**。
             *
             * 实测（2026-10-10，真界面跑 vesting 创建）：表单上填「Cycle (days) = 30」，
             * 编译好的前端送进来的是 `2592000` —— 它自己把天换算成秒了，因为
             * PinkLock V2 那个参数就是秒。这里再乘一次 86400 就是**双倍换算**：
             * 18 档 × 30 天算出的是 **46,656,000 天**，锁的解锁日期落在公元 129767 年。
             *
             * 这个错法完全静默 —— 交易成功、事件齐全、eleven 个字段都读得回来，
             * 页面上那一行「Unlock Date」也照样渲染，只是那个日期谁也活不到。
             * 只有把两个模型的数**逐字段对一遍**（或者真跑一次）才看得出来。
             */
            endTime: uint64(tgeDate + steps * cycle),
            initialUnlockBps: uint16(tgeBps),
            steps: uint16(steps)
        });
    }

    /**
     * PinkLock's withdraw. Forwarded as a claim: the vault pays the
     * beneficiary, whoever calls, so the adapter calling it changes nothing
     * except who pays the gas.
     */
    function unlock(uint256 lockId) external {
        LockVaultV2.Lock memory l = vault.getLock(lockId);
        if (l.token == address(0)) revert UnknownLock(lockId);
        // The vault pays the beneficiary whoever calls — which is what makes
        // this forwardable at all.
        uint256 amount = vault.claim(lockId);
        emit LockRemoved(lockId, l.token, l.beneficiary, amount, block.timestamp);
    }

    /**
     * The four writes that used to revert, now forwarded.
     *
     * They were reverted because the vault's rules say "the beneficiary, and
     * nobody else" — and the beneficiary is the *user*, while the caller here
     * is this contract. The way through is not to weaken that: it is the
     * `agent` field a lock declares at creation (see `LockVaultV2.Lock.agent`),
     * which this adapter sets to itself. The vault lets the agent do exactly
     * what the beneficiary may do and nothing more, and the pairing is visible
     * on the lock from its first block.
     *
     * Each of these still refuses anyone who is not the beneficiary — the extra
     * power the vault granted this contract is not a power it hands out.
     */
    function transferLockOwnership(uint256 id, address newOwner) external {
        _requireBeneficiary(id);
        vault.transferLock(id, newOwner);
    }

    function renounceLockOwnership(uint256 id) external {
        _requireBeneficiary(id);
        vault.renounce(id);
    }

    /**
     * Update the amount and the unlock date.
     *
     * Growing the amount means the vault will pull `delta` **from here**, so the
     * tokens have to come here first and be approved — the same two steps as
     * `_create`, and for the same reason: the vault pulls from its own caller.
     * A shrink needs none of that; the vault refunds the beneficiary directly.
     */
    function editLock(uint256 id, uint256 amount, uint256 unlockDate) external {
        _requireBeneficiary(id);
        LockVaultV2.Lock memory l = vault.getLock(id);
        if (l.token == address(0)) revert UnknownLock(id);

        if (amount > l.amount) {
            uint256 delta = amount - l.amount;
            (bool ok, bytes memory data) = l.token.call(
                abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), delta)
            );
            if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert Unsupported("token transferFrom");
            (bool ok2, bytes memory data2) = l.token.call(
                abi.encodeWithSignature("approve(address,uint256)", address(vault), delta)
            );
            if (!ok2 || (data2.length != 0 && !abi.decode(data2, (bool)))) revert Unsupported("token approve");
        }

        vault.editLock(id, uint128(amount), uint64(unlockDate));
    }

    function editLockDescription(uint256 id, string calldata description) external {
        _requireBeneficiary(id);
        vault.setLabel(id, _label(description));
    }

    /** The beneficiary of `id`, or revert. The vault grants the agent its power; this is what keeps it from handing it on. */
    function _requireBeneficiary(uint256 id) private view {
        LockVaultV2.Lock memory l = vault.getLock(id);
        if (l.token == address(0)) revert UnknownLock(id);
        if (msg.sender != l.beneficiary) revert Unsupported("not the lock owner");
    }

    function multipleVestingLock(address[] calldata, uint256[] calldata, address, bool, uint256, uint256, uint256, uint256, string calldata)
        external
        pure
        returns (uint256[] memory)
    {
        revert Unsupported("multipleVestingLock");
    }

    /// One lock's schedule, in our vocabulary. See `_vestingSchedule`.
    struct Schedule {
        uint64 startTime;
        uint64 cliffTime;
        uint64 endTime;
        uint16 initialUnlockBps;
        uint16 steps;
    }

    function _create(
        address owner,
        address token,
        bool isLpToken_,
        uint256 amount,
        Schedule memory s,
        string calldata description
    ) private returns (uint256 id) {
        // The vault pulls from its own caller, so the tokens come here first.
        // `transferFrom` returning nothing is common (USDT-style); a token that
        // reverts on failure reverts the whole call, which is the point.
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert Unsupported("token transferFrom");

        (bool ok2, bytes memory data2) = token.call(
            abi.encodeWithSignature("approve(address,uint256)", address(vault), amount)
        );
        if (!ok2 || (data2.length != 0 && !abi.decode(data2, (bool)))) revert Unsupported("token approve");

        id = vault.createLock(
            LockVaultV2.CreateParams({
                token: token,
                amount: amount,
                beneficiary: owner,
                // The owner stays the beneficiary — the vault's records must keep
                // saying the user owns their own lock — and this contract is
                // declared alongside as the agent, which is what lets the
                // mirrored front end's transfer / renounce / edit buttons reach
                // the vault at all (it calls *here*, not there). Declared up
                // front so it is part of the lock from the first block rather
                // than a power granted later.
                agent: address(this),
                startTime: s.startTime,
                cliffTime: s.cliffTime,
                endTime: s.endTime,
                initialUnlockBps: s.initialUnlockBps,
                steps: s.steps,
                revocable: false,
                transferable: true,
                label: _label(description)
            })
        );

        isLpToken[id] = isLpToken_;
        _idsByToken[token].push(id);
        _idsByOwner[owner].push(id);
    }

    /** The vault stores a bytes32 label; the first 31 bytes of the description. */
    function _label(string calldata description) private pure returns (bytes32 out) {
        bytes calldata b = bytes(description);
        uint256 n = b.length > 31 ? 31 : b.length;
        for (uint256 i = 0; i < n; i++) out |= bytes32(b[i]) >> (8 * i);
    }

    /** …and back out again, so the record page shows what was typed. */
    function _unlabel(bytes32 label) private pure returns (string memory) {
        uint256 n = 0;
        while (n < 32 && label[n] != 0) n++;
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; i++) out[i] = label[i];
        return string(out);
    }

    // ----------------------------------------------------------------- views
    //
    // Two id conventions meet here, and mixing them up is silent. Our vault
    // numbers locks **from 1** (`_nextLockId = 1`, so the first lock is id 1);
    // PinkLock numbers from 1 too, *but* its `getTotalLockCount` /
    // `getLockAt(index)` / `getCumulative*Info(start, end)` take a **count**
    // and **0-based indices** over the global list. So `index + 1` is the id,
    // and `nextLockId - 1` is the count — an off-by-one here renders as one
    // missing row or one phantom row, not as an error.

    function getLockById(uint256 lockId) external view returns (PinkLockView memory) {
        return _view(lockId);
    }

    function getLockAt(uint256 index) external view returns (PinkLockView memory) {
        return _view(index + 1);
    }

    function getLocksForToken(address token, uint256 start, uint256 end) external view returns (PinkLockView[] memory) {
        return _slice(_idsByToken[token], start, end);
    }

    function totalLockCountForToken(address token) external view returns (uint256) {
        return _idsByToken[token].length;
    }

    function getTotalLockCount() external view returns (uint256) {
        return vault.nextLockId() - 1;
    }

    function withdrawableTokens(uint256 lockId) external view returns (uint256) {
        return vault.claimable(lockId);
    }

    function cumulativeLockInfo(address token) external view returns (address, address, uint256) {
        return (token, address(0), _lockedAmountOf(token));
    }

    function getCumulativeNormalTokenLockInfo(uint256 start, uint256 end) external view returns (PinkLockView[] memory) {
        return _range(start, end);
    }

    function getCumulativeLpTokenLockInfo(uint256 start, uint256 end) external view returns (PinkLockView[] memory) {
        return _range(start, end);
    }

    function getCumulativeNormalTokenLockInfoAt(uint256 index) external view returns (PinkLockView memory) {
        return _view(index + 1);
    }

    function getCumulativeLpTokenLockInfoAt(uint256 index) external view returns (PinkLockView memory) {
        return _view(index + 1);
    }

    function normalLocksForUser(address user) external view returns (PinkLockView[] memory) {
        return _slice(_idsByOwner[user], 0, type(uint256).max);
    }

    function lpLocksForUser(address user) external view returns (PinkLockView[] memory) {
        return _slice(_idsByOwner[user], 0, type(uint256).max);
    }

    function normalLockForUserAtIndex(address user, uint256 index) external view returns (PinkLockView memory) {
        return _view(_idsByOwner[user][index]);
    }

    function lpLockForUserAtIndex(address user, uint256 index) external view returns (PinkLockView memory) {
        return _view(_idsByOwner[user][index]);
    }

    function normalLockCountForUser(address user) external view returns (uint256) {
        return _idsByOwner[user].length;
    }

    function lpLockCountForUser(address user) external view returns (uint256) {
        return _idsByOwner[user].length;
    }

    function totalLockCountForUser(address user) external view returns (uint256) {
        return _idsByOwner[user].length;
    }

    function allNormalTokenLockedCount() external view returns (uint256) {
        return vault.nextLockId() - 1;
    }

    function allLpTokenLockedCount() external view returns (uint256) {
        return vault.nextLockId() - 1;
    }

    function totalTokenLockedCount() external view returns (uint256) {
        return vault.nextLockId() - 1;
    }

    function paused() external pure returns (bool) {
        return false;
    }

    // --------------------------------------------------------------- helpers

    function _view(uint256 lockId) private view returns (PinkLockView memory v) {
        LockVaultV2.Lock memory l = vault.getLock(lockId);
        if (l.token == address(0)) revert UnknownLock(lockId);

        // cycle/cycleBps are re-derived from the schedule we stored: `steps`
        // tranches over `endTime - startTime`, each releasing an equal share of
        // the tail. PinkLock's record page prints these as "every N days, X%".
        uint256 span = l.endTime > l.startTime ? l.endTime - l.startTime : 0;
        uint256 cycleDays = l.steps == 0 ? 0 : span / l.steps / 1 days;
        uint256 cycleBps = l.steps == 0 ? 0 : (10_000 - l.initialUnlockBps) / l.steps;

        v = PinkLockView({
            id: lockId,
            token: l.token,
            owner: l.beneficiary,
            amount: l.amount,
            lockDate: l.startTime,
            tgeDate: l.cliffTime,
            tgeBps: l.initialUnlockBps,
            cycle: cycleDays,
            cycleBps: cycleBps,
            unlockedAmount: l.claimed,
            description: _unlabel(l.label)
        });
    }

    /**
     * `start`/`end` 是**闭区间**，两端都算 —— 这是 PinkLock 的约定，不是我们的。
     *
     * 判据是调用方自己算出来的范围：`getLockedAmountInPinklockV2` 里有
     * `Array(count).fill(null).map((t,e)=>e)` 再 `chunk(...,100)`，于是**只有一条锁时
     * 它传的是 `[0, 0]`**。半开区间（end 不含）会把这一条整段吃掉：
     * `getLocksForToken(token, 0, 0)` 回空数组，代币页的「Lock Records」就是一张
     * 只有表头的空表 —— 而 `Current Locked Amount` 照常显示（它走的是另一个调用），
     * 所以看起来像"这把锁还没有记录"。
     * 2026-10-10 全量自检抓到，实测：`(0,0) → 0 条`、`(0,1) → 1 条`。
     */
    function _slice(uint256[] storage ids, uint256 start, uint256 end) private view returns (PinkLockView[] memory out) {
        if (ids.length == 0 || start >= ids.length) return new PinkLockView[](0);
        if (end >= ids.length) end = ids.length - 1;
        out = new PinkLockView[](end - start + 1);
        for (uint256 i = start; i <= end; i++) out[i - start] = _view(ids[i]);
    }

    /// 0-based index range over the global list → 1-based ids. 同样**闭区间**。
    function _range(uint256 start, uint256 end) private view returns (PinkLockView[] memory out) {
        uint256 count = vault.nextLockId() - 1;
        if (count == 0 || start >= count) return new PinkLockView[](0);
        if (end >= count) end = count - 1;
        out = new PinkLockView[](end - start + 1);
        for (uint256 i = start; i <= end; i++) out[i - start] = _view(i + 1);
    }

    function _lockedAmountOf(address token) private view returns (uint256 sum) {
        uint256[] storage ids = _idsByToken[token];
        for (uint256 i = 0; i < ids.length; i++) {
            LockVaultV2.Lock memory l = vault.getLock(ids[i]);
            sum += uint256(l.amount) - uint256(l.claimed);
        }
    }
}
