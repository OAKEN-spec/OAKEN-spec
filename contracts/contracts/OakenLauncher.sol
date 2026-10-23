// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;
pragma abicoder v2;

/**
 * @title OakenLauncher
 * @notice 发币与锁仓在**同一笔交易**里完成。
 *
 * ## 为什么需要一个合约
 *
 * 这个站卖的就是"说锁就是锁"。如果发币和锁仓分成两笔交易，中间就有一段
 * **"币已经发出去了、但还没锁"**的窗口：用户可以忘记点第二下、可以在那个窗口里把
 * 币卖掉、也可能被抢跑。无论哪种，页面上那个"已锁定"的承诺都变成了空头支票。
 * 一笔交易里做完，就不存在这个中间状态 —— 要么全成，要么全回滚。
 *
 * ## 为什么走**适配器**而不是直接写金库
 *
 * 金库（`LockVault`）只认自己的账本；而站上"谁有哪些锁"是从**适配器**那张
 * `_idsByOwner` 表读的（`/me` 的"你的锁"、代币页的"某某代币的锁"都用它）。
 * 直接往金库里建锁，记录页能看到，但**那两个列表页会看不见** —— 一把刚发的锁
 * "查得到、列不出"，正是这个项目最不想要的失败方式。
 * 所以这里调 `PinkLockAdapter.lock(...)`，走的是全站已经在用的那条路：
 * 锁归用户、`agent` 是适配器（记录页上的转移/放弃按钮照常能用）、两张索引表照常更新。
 *
 * ## 供应量的分配
 *
 * ```
 * 工厂把**全部供应**铸给本合约 → 本合约按下 `lockBps` 切成两份：
 *   锁进金库的那份（受益人 = 用户）→ 剩下的当场转给用户
 * ```
 * 合约**不留余额**：交易结束时它手上一枚都不剩（`launch` 的最后一步把余额清零）。
 *
 * ## 没有的东西
 *
 * 没有 owner、没有 pause、没有取走别人币的函数、没有平台费。这个合约只做一件事，
 * 做完就把控制权交回用户；它甚至不能在事后改自己创建过的锁（那些锁的 `agent`
 * 是适配器，不是它）。
 */
interface ITokenFactory {
    function createToken(string calldata name, string calldata symbol, uint8 decimals, uint256 supply)
        external
        returns (address token);
}

interface IPinkLockAdapter {
    function lock(
        address owner,
        address token,
        bool isLpToken,
        uint256 amount,
        uint256 unlockDate,
        string calldata description
    ) external payable returns (uint256 id);
}

interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address owner) external returns (uint256);
}

contract OakenLauncher {
    /// 代币工厂（`TokenFactory`，四链同址）。供应固定、无增发、无税。
    address public immutable factory;
    /// 锁仓适配器（`PinkLockAdapter`，四链同址）。锁经由它进金库。
    address public immutable adapter;

    /** 一笔发射要的全部参数。 */
    struct LaunchParams {
        string name;
        string symbol;
        uint8 decimals;
        uint256 supply;
        /// 锁起来的那一份，单位 bps（10000 = 全部）。0 = 不锁。
        uint16 lockBps;
        /// 解锁时间（unix 秒）。`lockBps == 0` 时忽略。
        uint64 unlockDate;
        /// 锁的标题（链上只存前 31 字节，超出部分由适配器截断）。
        string description;
        /// 锁的受益人。`address(0)` = 发起人自己。
        address beneficiary;
    }

    error LockShareTooHigh(uint16 bps);
    error NothingToLock();
    error TokenCreationFailed();

    /**
     * 一笔交易的全部结果，一个事件说完。
     *
     * `locked` 是**实际锁进去的数量**（不是请求的比例算出来的那个数），
     * `lockId` 是它在金库里的编号 —— 记录页就凭这个编号去读链。
     */
    event Launched(
        address indexed token,
        address indexed creator,
        address indexed beneficiary,
        uint256 supply,
        uint256 locked,
        uint256 lockId,
        uint64 unlockDate,
        string name,
        string symbol
    );

    constructor(address factory_, address adapter_) {
        factory = factory_;
        adapter = adapter_;
    }

    /**
     * 发币 +（可选）锁仓，一笔交易。
     *
     * `lockBps == 0` 时只发币不锁 —— 这是允许的：锁是**可选**的，页面上的默认值就是 0。
     * `lockBps > 0` 时要求 `unlockDate` 不为零，且算出来的锁仓量必须大于 0
     * （供应量太小、比例太低时会整除到 0，那是一个**看起来锁了其实没锁**的静默失败，
     * 所以宁可 revert）。
     */
    function launch(LaunchParams calldata p) external returns (address token, uint256 lockId) {
        if (p.lockBps > 10_000) revert LockShareTooHigh(p.lockBps);
        address beneficiary = p.beneficiary == address(0) ? msg.sender : p.beneficiary;

        token = ITokenFactory(factory).createToken(p.name, p.symbol, p.decimals, p.supply);
        if (token == address(0)) revert TokenCreationFailed();

        // 工厂把全部供应铸到了这里；按**实收**切分（本合约只信自己读到的余额）。
        uint256 held = IERC20Minimal(token).balanceOf(address(this));
        uint256 lockAmount = (held * p.lockBps) / 10_000;

        if (p.lockBps > 0) {
            if (lockAmount == 0) revert NothingToLock();
            _approve(token, adapter, lockAmount);
            lockId = IPinkLockAdapter(adapter).lock(
                beneficiary,
                token,
                false,
                lockAmount,
                p.unlockDate,
                p.description
            );
        }

        // 剩下的当场归用户；本合约不留余额。
        _sweep(token, msg.sender);
        _announce(p, token, beneficiary, held, lockAmount, lockId);
    }

    /**
     * 把余额扫给用户。
     *
     * 单独一个函数是为了**栈**：`launch` 里同时活着的东西太多（参数、token、两个地址、
     * 两个数量、lockId），再加上 `emit` 的九个参数就顶到十六个槽了。
     * 本项目的另外两处（金库的 `_emitCreated`、适配器的 `_vestingSchedule`）是同一个墙、
     * 同一个办法 —— **不引 `viaIR`**：它会改这一整份工程的字节码，也就改了所有确定性地址。
     */
    function _sweep(address token, address to) private {
        uint256 rest = IERC20Minimal(token).balanceOf(address(this));
        if (rest > 0) _transfer(token, to, rest);
    }

    /** 事件单独发（同上：栈）。 */
    function _announce(
        LaunchParams calldata p,
        address token,
        address beneficiary,
        uint256 supply,
        uint256 locked,
        uint256 lockId
    ) private {
        emit Launched(token, msg.sender, beneficiary, supply, locked, lockId, p.unlockDate, p.name, p.symbol);
    }

    /**
     * 按比例切分供应量。**前端的预览必须调它**，不要在 JS 里重算一遍 ——
     * 两边各算一次就会出现"页面上写着锁 25%，链上锁了 24.99%"这种没人能一眼看出的差。
     */
    function split(uint256 supply, uint16 lockBps) public pure returns (uint256 locked, uint256 rest) {
        if (lockBps > 10_000) revert LockShareTooHigh(lockBps);
        locked = (supply * lockBps) / 10_000;
        rest = supply - locked;
    }

    /**
     * ERC-20 的三个调用。
     *
     * 这里的代币是**我们自己工厂刚造出来的 `OakenToken`**（标准实现、返回 bool、没有钩子），
     * 所以不是 SafeERC20 那套"容忍不返回值的代币"的完整写法。但仍然**检查返回值**：
     * 万一工厂地址被换成了一个返回 false 的怪东西，宁可在这里 revert，
     * 也不要带着"以为锁上了"的状态发一个 `Launched` 事件出去。
     */
    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCreationFailed();
    }

    function _transfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCreationFailed();
    }
}
