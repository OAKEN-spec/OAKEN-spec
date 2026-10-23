// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @title Timelock —— admin 前面的那道公开延迟（2026-10-14 第二十二轮）
///
/// @notice 治理的第一档:把 15 个合约的 `admin` 全部 `transferAdmin` 到这个合约。
/// 从那以后**任何**参数变更（费率、mintCap、keeper、喂价上下限、质押周期、暂停）
/// 都只能走这条路:
///
///   proposer 调 `queue(target, data, eta)` → 等到 `eta` → **任何人**调
///   `execute(target, data, eta)` → 真正落到目标合约上。
///
/// 现在的角色:
///   · proposer  = **Safe 多签** + **Poll（投票合约）** —— 多签能提，
///     投票通过了也能提（`Poll.enqueue` 会替它调 queue）
///   · canceller = Safe —— 提案在延迟窗里被发现有问题的，还能撤
///   · executor  = **任何人** —— 执行是机械动作，谁付 gas 都一样
///
/// ══════════════════════════════════════════════════════════════════════════
/// 三条刻意的"小"
/// ══════════════════════════════════════════════════════════════════════════
///
/// ① **不带 value**。本站所有管理调用都是零转账的（`setParams`、`setKeeper`…）。
///    带 value 的 timelock 是另一个攻击面（谁能把 ETH 从 timelock 花出去），
///    这里根本不需要，就不给。
/// ② **id = keccak(target, data, eta)**，`eta` 由提议者给但必须 ≥ now + delay ——
///    这样同一个 (target, data) 在不同 eta 下是不同的提案，不会互相踩。
/// ③ **改自己的参数也要走自己**（`setDelay` / `setProposer` 都是 onlySelf）。
///    否则"谁能改时间锁"就成了后门。
contract OakenTimelock {
    uint256 public delay;
    mapping(address => bool) public isProposer;
    mapping(address => bool) public isCanceller;

    /// id → 可执行时刻（0 = 没排队）
    mapping(bytes32 => uint256) public etaOf;

    event Queued(bytes32 indexed id, address target, uint256 eta, bytes data);
    event Executed(bytes32 indexed id, address target, bytes data);
    event Cancelled(bytes32 indexed id);
    event DelayChanged(uint256 delay);
    event RoleChanged(address indexed who, string role, bool on);

    error NotProposer();
    error NotCanceller();
    error NotSelf();
    error ZeroAddress();
    error DelayTooShort(uint256 eta, uint256 earliest);
    error NotQueued(bytes32 id);
    error TooEarly(uint256 eta, uint256 now_);
    error AlreadyQueued(bytes32 id);

    constructor(uint256 delay_, address[] memory proposers_, address[] memory cancellers_) {
        delay = delay_;
        for (uint256 i = 0; i < proposers_.length; i++) {
            if (proposers_[i] == address(0)) revert ZeroAddress();
            isProposer[proposers_[i]] = true;
            emit RoleChanged(proposers_[i], "proposer", true);
        }
        for (uint256 i = 0; i < cancellers_.length; i++) {
            if (cancellers_[i] == address(0)) revert ZeroAddress();
            isCanceller[cancellers_[i]] = true;
            emit RoleChanged(cancellers_[i], "canceller", true);
        }
        emit DelayChanged(delay_);
    }

    modifier onlyProposer() {
        if (!isProposer[msg.sender]) revert NotProposer();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    function idOf(address target, bytes calldata data, uint256 eta) public pure returns (bytes32) {
        return keccak256(abi.encode(target, data, eta));
    }

    /// @notice 排队。`eta` 必须 ≥ 现在 + delay（想提前执行就必须先改 delay，
    ///         而改 delay 本身也要走这条流程）。
    function queue(address target, bytes calldata data, uint256 eta) external onlyProposer returns (bytes32 id) {
        if (target == address(0)) revert ZeroAddress();
        uint256 earliest = block.timestamp + delay;
        if (eta < earliest) revert DelayTooShort(eta, earliest);
        id = idOf(target, data, eta);
        if (etaOf[id] != 0) revert AlreadyQueued(id);
        etaOf[id] = eta;
        emit Queued(id, target, eta, data);
    }

    /// @notice 到期后执行。**谁都能叫** —— 执行是机械的，不需要权限。
    function execute(address target, bytes calldata data, uint256 eta) external returns (bytes memory ret) {
        bytes32 id = idOf(target, data, eta);
        uint256 etaStored = etaOf[id];
        if (etaStored == 0) revert NotQueued(id);
        if (block.timestamp < etaStored) revert TooEarly(etaStored, block.timestamp);
        delete etaOf[id];
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) {
            // 把内层的 revert 原样抛出去 —— 吞掉理由的话，
            // "为什么这笔治理动作失败了"在链上就没有任何线索。
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        emit Executed(id, target, data);
    }

    /// @notice 撤掉一个还没执行的提案。
    function cancel(address target, bytes calldata data, uint256 eta) external {
        if (!isCanceller[msg.sender]) revert NotCanceller();
        bytes32 id = idOf(target, data, eta);
        if (etaOf[id] == 0) revert NotQueued(id);
        delete etaOf[id];
        emit Cancelled(id);
    }

    // ── 改自己:全部 onlySelf（要先 queue→execute 到自己）────────────────────

    function setDelay(uint256 delay_) external onlySelf {
        delay = delay_;
        emit DelayChanged(delay_);
    }

    function setProposer(address who, bool on) external onlySelf {
        if (who == address(0)) revert ZeroAddress();
        isProposer[who] = on;
        emit RoleChanged(who, "proposer", on);
    }

    function setCanceller(address who, bool on) external onlySelf {
        if (who == address(0)) revert ZeroAddress();
        isCanceller[who] = on;
        emit RoleChanged(who, "canceller", on);
    }
}
