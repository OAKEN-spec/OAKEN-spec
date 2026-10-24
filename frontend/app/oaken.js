// OAKEN 的共享运行时：链配置、合约读写、钱包、外壳（顶栏/页脚）、格式化、提示。
//
// 零构建：普通 ES module，直接吃 `<script type="module">`。ethers 用 UMD 版
// （`window.ethers`），所以不需要打包器，也没有 node_modules 那一套。
//
// 一条设计原则：**页面上的每个数字都要能追到来源** ——
// 要么来自链（读合约），要么来自我们自己的接口（`/api/v1/lockers`）。
// 读不到就显示 `—`，**不编**（[[fallback-that-looks-like-real-data]]）。
import { icon } from './icons.js';

/* ── 链 ──────────────────────────────────────────────────────────────────
 *
 * **只认"真的部署过合约"的链**：表从我们自己的 `/api/chains` 拿，里面 `live`
 * 就是 `src/chains.mjs` 的 `deployBlock != null`。没部署的链不列、不切、不让发交易 ——
 * 往一个没有代码的地址发交易会**成功且无声**（[[local-chain-needs-canonical-infra]] 那一族），
 * 所以"能不能选"这件事必须由注册表说了算，不能由页面猜。
 *
 * 地址是**跨链同址**（确定性部署），所以这里没有 per-chain 地址表 —— 只有链自己的
 * RPC / explorer / 原生币。加一条链 = 部署 + 注册表写一行，前端一个字都不用改。
 */
export const ADAPTER = '0x16e02A106fE6E978fB98F76756B3a06b4995a7A6';
export const VAULT = '0xe410d0a21C1376992874a9bEEeE0d623A50D4a34';
/** v2 (2026-10-23). Same addresses on every deployed chain. */
export const ADAPTER_V2 = '0xDBE1f3dc1d6E6759355E1B164231748f0589cb41';
export const VAULT_V2 = '0xbC511F31967D9EBF775d203661a2BEfF6AA42615';
export const OAKEN_LAUNCHER_V2 = '0x0d7cCEA7BabC5e3b4849267740D8fBBe6C4FDa58';
/** v3 (2026-10-24). V2 plus the revoke clamp; new locks and launches use it. */
export const ADAPTER_V3 = '0x6022DA059FAa0673E3058ADECEef375c2Abfb4A1';
export const VAULT_V3 = '0xd4064d8E73AAB53D7d9efd8A6E8DBE2003d1de4B';
export const OAKEN_LAUNCHER_V3 = '0x4488C369116D0C6FEA84162313c3840976D5A9a5';
/**
 * v4 (2026-10-24). The upgradeable continuation: these are ERC1967 **proxy**
 * addresses, not implementations. New locks and launches use v4. The admin is a
 * 2-of-3 multisig with a 48h delay; v1–v3 remain immutable and readable.
 */
export const ADAPTER_V4 = '0xA2898528eb4Aea0bDAf47202A5BA3bA4f58F831c';
export const VAULT_V4 = '0x5221A10B772D5e2d51B60E8e3dd5DA9338b04ab0';
export const OAKEN_LAUNCHER_V4 = '0x9600f22d2f629904B44c7dA2d958f5AfB3a1e5Ff';
export const V4_MULTISIG = '0xCb847B572352156be50c90FBc752cfd032114666';
export const V4_PROXY_ADMIN = '0xDB998916A34b87c7DA337d922bC1219970FA0319';
/** Every vault generation, oldest first. Lists and per-owner reads cover all three. */
export const LOCK_VERSIONS = ['v1', 'v2', 'v3', 'v4'];
/** Where new locks and launches go. */
export const NEW_VERSION = 'v4';
/** Resolve a contract set. v1 is the default so old URLs keep working. */
export function contractSet(version = 'v1') {
  if (version === 'v4') return { adapter: ADAPTER_V4, vault: VAULT_V4, launcher: OAKEN_LAUNCHER_V4 };
  if (version === 'v3') return { adapter: ADAPTER_V3, vault: VAULT_V3, launcher: OAKEN_LAUNCHER_V3 };
  if (version === 'v2') return { adapter: ADAPTER_V2, vault: VAULT_V2, launcher: OAKEN_LAUNCHER_V2 };
  return { adapter: ADAPTER, vault: VAULT, launcher: OAKEN_LAUNCHER };
}

/** 没连钱包、URL 里也没写链时的落点。 */
export const DEFAULT_CHAIN_ID = 4663;

/** A small chain glyph for selectors and chips. Same 24-grid stroke family as icons.js. */
const CHAIN_ICONS = { 4663: 'chainRobinhood', 56: 'chainBnb', 8453: 'chainBase', 137: 'chainPolygon', 31337: 'chainHardhat', solana: 'chainSolana' };
export function chainIcon(id, size = 14) {
  return icon(CHAIN_ICONS[id] || CHAIN_ICONS[Number(id)] || 'globe', size);
}

let _chains = null;
/** 部署过的链（带缓存）。拿不到接口就回空数组 —— 页面据此显示"读不到链表"，不编一条。 */
export async function chains() {
  if (_chains) return _chains;
  try {
    /* 我们自己的接口也要带超时 —— 它挂了页面同样不能卡死（一条规矩：任何网络调用都有上限）。 */
    const j = await fetch('/api/chains', { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    _chains = (j.chains || []).filter((c) => c.live).map((c) => ({
      id: c.chainId,
      hex: '0x' + c.chainId.toString(16),
      name: c.name,
      short: c.shortName || c.name,
      /* URL 里那一段由**注册表**给（`src/chains.mjs` 的 slug），前端不再自己推导 ——
         两边各推一次就会出现 `/locks/bnb/…` 和 `/locks/bsc/…` 同时存在，其中一个必然 404。 */
      slug: c.slug,
      rpc: Array.isArray(c.rpc) ? c.rpc[0] : c.rpc,
      rpcs: Array.isArray(c.rpc) ? c.rpc : [c.rpc],
      explorer: c.explorer,
      native: c.nativeCurrency?.symbol || 'ETH',
      launcherBlock: c.launcherBlock ?? null,
      v2DeployBlock: c.v2DeployBlock ?? null,
      v2LauncherBlock: c.v2LauncherBlock ?? null,
      v3DeployBlock: c.v3DeployBlock ?? null,
      v3LauncherBlock: c.v3LauncherBlock ?? null,
    }))
    /**
     * 排序：**我们的主链（4663）排最前**，其余按链 id。
     * 不排的话顺序是注册表的对象键顺序（56, 8453, 137, 4663），
     * 网络切换器第一眼看到的会是别人的链。
     */
    .sort((a, b) => (a.id === DEFAULT_CHAIN_ID ? -1 : b.id === DEFAULT_CHAIN_ID ? 1 : a.id - b.id));
  } catch { _chains = []; }
  /* 探测改到**第一次真的用这条链**的时候（`provider()`）—— 记录页/代币页只读一条链，
     以前每次打开都会把四条链的所有 RPC（~32 个请求）全探一遍，纯属陪跑。 */
  return _chains;
}

/** URL 里那一段（`/locks/bsc/record/7`）→ 链表里的一条。认不出来回 null。 */
export async function chainBySlug(slug) {
  if (!slug) return null;
  const want = String(slug).toLowerCase();
  return (await chains()).find((c) => c.slug === want) || null;
}

/**
 * 当前应该用哪条链，按这个顺序定：
 *   ① 页面指定的（记录页/代币页从 URL 读到的链）
 *   ② 钱包当前所在的链 —— 这就是"自动识别"：钱包在 BSC 就锁 BSC，不用手选
 *   ③ **用户上次在顶栏选的那条链**（存在本地；一次刷新就丢的旧行为是个静默空操作：
 *      没连钱包时选 Base 会重载成默认链，看着像"那颗菜单是坏的"）
 *   ④ 默认链（4663）
 * 钱包在一条我们**没部署**的链上时，回的是 ③/④，同时 `wallet.ensureChain()` 会提示切换。
 */
const SITE_CHAIN_LS = 'oaken.chain';
/** 顶栏选过的那条链（数字 id；没选过/读取失败 → null）。 */
export function siteChain() {
  try { const v = Number(localStorage.getItem(SITE_CHAIN_LS)); return Number.isFinite(v) && v > 0 ? v : null; }
  catch { return null; }
}
export function setSiteChain(id) {
  try { localStorage.setItem(SITE_CHAIN_LS, String(Number(id))); } catch { /* 隐私模式 */ }
}

export async function currentChain(prefer = null) {
  const live = await chains();
  if (prefer) {
    const hit = live.find((c) => c.id === Number(prefer.id ?? prefer));
    if (hit) return hit;
  }
  const walletId = await wallet.chainId();
  const picked = siteChain();
  return live.find((c) => c.id === walletId)
    || live.find((c) => c.id === picked)
    || live.find((c) => c.id === DEFAULT_CHAIN_ID)
    || live[0]
    || null;
}

/** 兼容旧调用：默认那条链的静态描述（页面在 await 之前画骨架时用）。 */
export const CHAIN = {
  id: DEFAULT_CHAIN_ID,
  hex: '0x1237',
  name: 'Robinhood Chain',
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  native: 'ETH',
};

/** 我们用到的那几个函数（不搬整份 ABI —— 那是 9 万字节的产物）。 */
export const ABI = [
  'function getTotalLockCount() view returns (uint256)',
  // ⚠ 这两条**返回的是结构体**（tuple），不是展平的字段列表 —— 手写成
  //   `returns (address owner, address token, ...)` 时 ethers 会按位置解，
  //   字段名对不上，页面拿到 undefined（表现是 `Invalid time value`）。
  //   形状抄自 `contracts/artifacts/.../PinkLockAdapter.json`，不是猜的。
  'function getLockById(uint256 id) view returns (tuple(uint256 id,address token,address owner,uint256 amount,uint256 lockDate,uint256 tgeDate,uint256 tgeBps,uint256 cycle,uint256 cycleBps,uint256 unlockedAmount,string description))',
  'function getLocksForToken(address token,uint256 start,uint256 end) view returns (tuple(uint256 id,address token,address owner,uint256 amount,uint256 lockDate,uint256 tgeDate,uint256 tgeBps,uint256 cycle,uint256 cycleBps,uint256 unlockedAmount,string description)[])',
  'function totalLockCountForToken(address token) view returns (uint256)',
  /**
   * 某个地址名下的锁。适配器记着"谁有哪些锁号"（`_idsByOwner`），这是链上唯一一处
   * 能按**受益人**（而不是按代币）列出锁的地方 —— `/me` 要的就是它。
   * ⚠ 只包含**经适配器建的**锁；直接调金库建的锁不在这张表里。
   */
  'function totalLockCountForUser(address user) view returns (uint256)',
  'function normalLocksForUser(address user) view returns (tuple(uint256 id,address token,address owner,uint256 amount,uint256 lockDate,uint256 tgeDate,uint256 tgeBps,uint256 cycle,uint256 cycleBps,uint256 unlockedAmount,string description)[])',
  'function withdrawableTokens(uint256 id) view returns (uint256)',
  'function isLpToken(uint256 id) view returns (bool)',
  'function lock(address owner,address token,bool isLpToken,uint256 amount,uint256 unlockDate,string description) returns (uint256)',
  'function vestingLock(address owner,address token,bool isLpToken,uint256 amount,uint256 tgeDate,uint256 tgeBps,uint256 cycle,uint256 cycleBps,string description) returns (uint256)',
  'function unlock(uint256 id)',
  'function transferLockOwnership(uint256 id,address newOwner)',
  'function renounceLockOwnership(uint256 id)',
  // 记录页的"Update Lock / Edit Title"两个动作（PinkSale 记录页也有这两个）：
  //   · editLock 金额与日期**两个方向都允许**（金库的语义，见 LockVault.editLock 那段注释）；
  //   · editLockDescription 就是改锁的标题（链上只存 31 字节）。
  'function editLock(uint256 id,uint256 amount,uint256 unlockDate)',
  'function editLockDescription(uint256 id,string description)',
  'event LockAdded(uint256 indexed id,address token,address owner,uint256 amount,uint256 unlockDate)',
  /**
   * 金库自己的建锁事件 —— **锁号和"实收多少"的唯一权威来源**。
   *
   * 为什么不用"交易前后各读一次 `getTotalLockCount()` 再相减"：那是**写后读**，
   * 公共 RPC 落后几个块时两次读到同一个数，页面就显示 "Lock #?" —— 而币已经锁进去了
   * （2026-10-11 在 Base 上真踩过：授权已上链、读 allowance 还是 0）。
   * 收据里的日志是这笔交易自己的产物，不吃节点滞后。
   *
   * 一笔锁会发两条建锁事件：适配器的 `LockAdded` / `LockVested`，和金库的这条。
   * **实收数量只在金库这条里** —— 适配器记的是用户请求的数量，带税代币在它那儿
   * 看着是全额，到金库才是真正到账的数。
   */
  'event LockCreated(uint256 indexed lockId,address indexed token,address indexed creator,address beneficiary,address agent,uint256 amount,uint64 startTime,uint64 cliffTime,uint64 endTime,uint16 initialUnlockBps,uint16 steps,bool revocable,bool transferable,bytes32 label)',
];

/**
 * 金库自己的 Lock 结构 —— **排期的精确来源**。
 *
 * 为什么不从适配器那份 view 里反推：适配器的 `PinkLockView` 只有
 * `tgeBps / cycle(天) / cycleBps`，而它是**有损**的 —— `cycleBps` 是
 * `floor(tail / steps)`，反推 `steps = floor(tail / cycleBps)` 在
 * `tail = 10, steps = 4`（TGE 99.9%、每档 0.02%）这类角落会算成 5。
 * 步数错了，"下一次释放"和"全部释放"两个日期就跟着错。
 *
 * 金库的 `getLock` 直接把 `steps` / `endTime` / `cliffTime` 报出来，不用推。
 * **锁号是同一个空间**：适配器的 `_create` 返回的就是 `vault.createLock` 的 id，
 * 所以两个合约用同一个 `id` 读到的必然是同一把锁（生成锁那几笔都核过）。
 *
 * 字段顺序照着 `contracts/contracts/LockVault.sol` 的 struct 抄，错一个就整条解偏。
 */
export const VAULT_ABI = [
  'function getLock(uint256 lockId) view returns (tuple(address token,uint64 startTime,uint16 initialUnlockBps,bool revocable,bool transferable,address beneficiary,uint64 cliffTime,bool revoked,bool renounced,address creator,uint64 endTime,uint16 steps,uint128 amount,uint128 claimed,bytes32 label,address agent))',
  'function claimable(uint256 lockId) view returns (uint256)',
];
export function vault(chain = CHAIN, signerOrProvider, version = 'v1') {
  return new window.ethers.Contract(contractSet(version).vault, VAULT_ABI, signerOrProvider || provider(chain));
}


/**
 * 发射台：**发币 + 锁仓一笔交易**。四链同址（salt `launcher.v1`），
 * 两个构造参数（代币工厂、适配器）也都是跨链同址的常量。
 */
export const OAKEN_LAUNCHER = '0x1d7561fC331594820382E8dd64582645EbafD873'

export const LAUNCHER_ABI = [
  // ⚠ 结构体参数写成 tuple；返回值是两个标量（token, lockId）
  'function launch((string name,string symbol,uint8 decimals,uint256 supply,uint16 lockBps,uint64 unlockDate,string description,address beneficiary) p) returns (address token, uint256 lockId)',
  /** 前端的预览**必须**调它，别在 JS 里重算比例 —— 两边各算一次就会出现"页面写 25%、链上 24.99%" */
  'function split(uint256 supply, uint16 lockBps) pure returns (uint256 locked, uint256 rest)',
  'event Launched(address indexed token,address indexed creator,address indexed beneficiary,uint256 supply,uint256 locked,uint256 lockId,uint64 unlockDate,string name,string symbol)',
]

export function launcher(chain, signerOrProvider, version = 'v1') {
  return new window.ethers.Contract(contractSet(version).launcher, LAUNCHER_ABI, signerOrProvider || provider(chain))
}

/** 一笔发射交易的收据 → `Launched` 的参数。没有它说明这笔不是发射（或日志没解析出来）。 */
export function launchedFromReceipt(receipt, chain = CHAIN, version = 'v1') {
  const set = contractSet(version);
  const iface = launcher(chain, null, version).interface
  for (const log of receipt?.logs || []) {
    if (log.address && log.address.toLowerCase() !== set.launcher.toLowerCase()) continue
    try {
      const p = iface.parseLog({ topics: [...log.topics], data: log.data })
      if (p && p.name === 'Launched') return p.args
    } catch { /* 不是我们的事件，下一条 */ }
  }
  return null
}

/**
 * 某个地址**发射过的代币** —— 扫发射合约的 `Launched` 日志（`creator` 是 indexed，
 * 所以这是链上唯一能"按人"列出他发过什么的地方）。
 *
 * 为什么要它：**只发不锁**的代币在站上没有任何痕迹 —— `/me` 的锁列表读的是适配器那张
 * 表，锁才在表里；用户关掉成功面板就再也找不回那个地址了。
 *
 * ⚠ 这是**区间扫描**，不是索引进而：一次扫 `lookback` 个块（默认 ~100 万块），
 * 每块区间失败就**对半分再试一次**（公共 RPC 对 range 的脾气各不相同），
 * 仍然失败就如实返回 `complete: false` —— **不把"没扫到"说成"没有"**。
 */
export async function launchesByCreator(chain, address, { lookback = 1_000_000, chunk = 90_000, maxChunks = 8, budgetMs = 7_000, version = 'v1' } = {}) {
  const p = provider(chain)
  const head = await p.getBlockNumber()
  /**
   * 扫描的下限：**发射合约的部署块**（注册表给，经 `/api/chains` 下来）。
   * 早于它的区间不可能有 `Launched` —— 从创世或"一年前"扫，纯属白烧 RPC。
   * 注册表没给（老接口）才退回固定回看窗口。
   */
  const launcherStart = version === 'v4' ? chain?.v4LauncherBlock : version === 'v3' ? chain?.v3LauncherBlock : version === 'v2' ? chain?.v2LauncherBlock : chain?.launcherBlock
  const floor = launcherStart != null ? Math.max(0, launcherStart) : Math.max(0, head - lookback)
  const topic = window.ethers.id('Launched(address,address,address,uint256,uint256,uint256,uint64,string,string)')
  const who = window.ethers.zeroPadValue(String(address).toLowerCase(), 32)
  const set = contractSet(version)
  const iface = launcher(chain, null, version).interface
  const out = []
  let oldest = head
  let complete = true

  /**
   * 读一段日志，**每个端点带超时**。
   *
   * ⚠ 为什么必须带：`mainnet.base.org` 的 `eth_getLogs` 会**不回应也不报错** ——
   * await 就永远挂在那里，`/me` 的面板永远停在 "Reading…"（整页看着像坏了，其实只有一个
   * 查询没回来）。一个端点超时就换链自带的**下一个**端点（注册表里每个链都有备选列表），
   * 全都读不动才如实记一笔失败。
   */
  const rpcList = (chain && chain.rpcs && chain.rpcs.length ? chain.rpcs : [chain && chain.rpc]).filter(Boolean)
  const endpoints = rpcList.map((url) => new window.ethers.JsonRpcProvider(url, chain.id, { staticNetwork: true }))
  const withTimeout = (pr, ms) => Promise.race([
    pr,
    new Promise((_, rej) => setTimeout(() => rej(new Error('rpc timeout')), ms)),
  ])
  /**
   * **总预算**：一次 /me 不该为了历史记录等一分钟。预算之内每个端点最多 5 秒、逐个兜底；
   * 预算用完就停 —— 停下来的部分如实标成"没扫到"，不假装扫过了。
   */
  const deadline = Date.now() + budgetMs
  const getLogs = async (from, to) => {
    for (const ep of endpoints) {
      const left = deadline - Date.now()
      if (left < 500) return null
      try {
        return await withTimeout(ep.getLogs({ address: set.launcher, topics: [topic, null, who], fromBlock: from, toBlock: to }), Math.min(5000, left))
      } catch { /* 这个端点不行（超时/限流/区间太大），换下一个 */ }
    }
    return null
  }
  const scan = async (from, to) => {
    const logs = await getLogs(from, to)
    if (logs) return logs
    if (to - from < 2_000) { complete = false; return null }      // 再小也读不动 → 记一笔失败
    const mid = Math.floor((from + to) / 2)
    const a = await scan(from, mid)
    const b = await scan(mid + 1, to)
    return a === null || b === null ? null : [...a, ...b]
  }

  /**
   * ⚠ **扫描有上限**。不限的话，随着链变长，这一页每次都要从链头扫到发射合约的部署块 ——
   * 4663 是 10 块/秒，一个月就是 2600 万块 ≈ 290 次查询，开一次 /me 要几十秒。
   * 现在最多扫 maxChunks x chunk（默认 8 x 90k = 72 万块，约 20 小时）。
   * **扫不到的地方不假装没有**：回 complete:false，页面会写明没扫到哪一段。
   */
  let scanned = 0
  for (let to = head; to > floor && scanned < maxChunks; to -= chunk) {
    scanned++
    const from = Math.max(floor, to - chunk + 1)
    const logs = await scan(from, to)
    if (logs) {
      oldest = from
      for (const l of logs) {
        try {
          const e = iface.parseLog({ topics: [...l.topics], data: l.data })
          if (!e) continue
          out.push({
            chainId: chain.id, vault: version, token: e.args.token, creator: e.args.creator, beneficiary: e.args.beneficiary,
            supply: e.args.supply, locked: e.args.locked, lockId: String(e.args.lockId),
            unlockDate: Number(e.args.unlockDate), name: e.args.name, symbol: e.args.symbol,
            block: l.blockNumber, tx: l.transactionHash,
          })
        } catch { /* 解不出来的这条跳过 */ }
      }
    }
    if (oldest !== from) break      // 这一块读不动，别再往前扫了
  }
  out.sort((a, b) => b.block - a.block)
  const truncated = scanned >= maxChunks && oldest > floor
  if (truncated) complete = false          // 扫到上限本身也是没扫全，和某段读不动一样如实报出来
  return { launches: out, complete, scannedBlocks: head - oldest, oldestBlock: oldest, head, floor, truncated }
}

/* ── Pons / Genius（同源代码的两条第三方曲线发射台）──────────────────────
 *
 * **Pons**（只在 4663）：自己发币、自己建曲线、毕业进 Uniswap V4 池；创建者有持续分成
 * （`creatorTaxBps` 实测 0–10%，上限读链上的 `maxCreatorTaxBps`）。
 *
 * **Genius**（只在 56）：2026-10-13 侦察确认它是 **Pons V2 的换链移植** —— Sourcify 源码
 * `GeniusLaunchFactory.sol` 头注释直认 "Derived from PonsV2LaunchFactory.sol … ported to
 * PancakeSwap Infinity CL"，连 selector（`launchToken` 0xf35abbcf/0xa72101af）与事件 topic0
 * （`0x8d4aad49…`）都逐一相同。所以**同一套 ABI、同一套参数、同一套读法**（`getLaunchedToken`、
 * `previewLaunchEconomics`、曲线 `getReserves` 都实测在）。差异只有三处：
 *   · 工厂地址不同、发射费不同（Pons 0.0005 ETH / Genius **0.002 BNB**，都现读 `launchFee()`）；
 *   · **Genius 的 `maxCreatorTaxBps()` = 0**（创建者税必须 0；创作者收益是内置的 0.25% 交易费分成）；
 *   · 毕业去向不同（Pons→Uniswap V4；Genius→PancakeSwap Infinity）。
 *
 * 两家的发射都是**我们编码**：参数在我们站上填，用户自己的钱包签名，
 * `creatorFeeRecipient` = 用户的地址 —— 那份创作费永远不经过我们。
 * 另外两件它们不做的事：**核实**（这个地址真的是它发的）和**锁**（毕业之后锁仓位）。
 */
export const PONS = {
  4663: {
    factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
    launchUrl: 'https://ponsfamily.com/launchpad',
  },
}

export const GENIUS = {
  56: {
    factory: '0x37eE8AeE29C5efd3C1A7edA6dF3F510779928a37',
    launchUrl: 'https://genius.fun',
  },
}

/**
 * 原子「发射 + 首买」路由 —— 两家工厂自己的 `launchForwarder`。
 *
 * 工厂的 `launchToken` **没有** dev buy 参数（源码：`if (msg.value != launchFee) revert`），
 * 但两家都把 `PonsV2LaunchAndBuy` / `GeniusLaunchAndBuy` 设成了可信转发器：
 * 一次调用里先 `launchTokenFor`、再在同一个交易里对刚建好的曲线 `buy`。
 * 这解决了"创建后、首买前"那两三个区块的裸奔窗口（源码注释里写得很直白）。
 *
 * 地址是**现读**两家工厂的 `launchForwarder()` 得到的（2026-10-21），
 * 与工厂里的值必须一致；换地址就改这里（和链上不是一个值时，调用会回 NotLaunchForwarder）。
 */
export const CURVE_LAUNCH_AND_BUY = {
  pons: { 4663: '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948' },
  genius: { 56: '0xd8b71b46498A36A4607EAb5C735BeE1DAb7F263d' },
}

/** 两家路由的 `TokenParams` 与工厂完全同形，所以参数仍由 `ponsLaunchParams` 生成。 */
export const CURVE_LAUNCH_AND_BUY_ABI = [
  'function launchAndBuy((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)',
  'function factory() view returns (address)',
]

export function curveLaunchAndBuy(family, chain, signerOrProvider) {
  const addr = (CURVE_LAUNCH_AND_BUY[family] || {})[chain?.id]
  if (!addr || !window.ethers) return null
  return new window.ethers.Contract(addr, CURVE_LAUNCH_AND_BUY_ABI, signerOrProvider || provider(chain))
}

const CURVE_FAMILIES = { pons: PONS, genius: GENIUS }

/** 「家族 × 链」→ 站点配置。families：`'pons'` | `'genius'`。 */
export function curveSite(family, chain) {
  return (CURVE_FAMILIES[family] || {})[chain?.id] || null
}

/**
 * Pons 的**发射入口**（`launchToken`，selector `0xa72101af`）。
 *
 * ⚠ 这里踩过一个很贵的弯路：它站上 bundle 里那份 ABI 里的 `launchV2` 算出来是 `0x283bbe28`，
 * 而链上真实在用的是 `0xa72101af` —— 一度以为"编不了"。后来发现**链上那个函数叫 `launchToken`**，
 * `launchV2` 属于同一产品里的**另一个**合约（赞助发射器）。ABI 抄自它生产包的模块 92154，
 * 并用**三笔真实交易的 calldata 逐字节重编码**验过（1188/1124/1156 字节全等）。
 *
 * ⚠ `expectedEconomics` **不能随便填**：它必须等于 `previewLaunchEconomics(configId, pairToken)`
 * 的**当前**返回值（链上实调过：`previewLaunchEconomics(0, 0x0)` = 0xa9fc75d4…）。
 * 所以出交易前**现读**，不要缓存、不要抄常量。
 *
 * ⚠ 创建时**没有可锁的份额**：供应进的是曲线，创建者手上是空的。
 * 想锁的话要等毕业之后（那时有池子和仓位）—— 页面必须如实说，不能拿"创建即锁定"糊。
 */
export const PONS_FACTORY_ABI = [
  'function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt) params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
  'function launchFee() view returns (uint256)',
  'function launchEnabled() view returns (bool)',
  'function canLaunch(address who) view returns (bool)',
  'function maxCreatorTaxBps() view returns (uint16)',
  'function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
  // ⚠ 工厂发的是 `TokenLaunched`（topic0 `0x8d4aad49…`，链上解过）+ 96B data。
  //   `LaunchedV2` 是**赞助发射器**那边的事件，工厂从来不发它 —— 拿它读收据会永远读到 null。
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
]

export function curveFactory(family, chain, signerOrProvider) {
  const cfg = curveSite(family, chain)
  if (!cfg || !window.ethers) return null
  return new window.ethers.Contract(cfg.factory, PONS_FACTORY_ABI, signerOrProvider || provider(chain))
}
export function ponsFactory(chain, signerOrProvider) { return curveFactory('pons', chain, signerOrProvider) }
export function geniusFactory(chain, signerOrProvider) { return curveFactory('genius', chain, signerOrProvider) }

/** 出交易前要现读的三个数：发射费、当前的经济参数哈希、创建者税上限。 */
export async function curveLaunchReadiness(family, chain) {
  const f = curveFactory(family, chain)
  if (!f) return null
  const [fee, economics, maxTax, enabled] = await Promise.all([
    f.launchFee(), f.previewLaunchEconomics(0, window.ethers.ZeroAddress), f.maxCreatorTaxBps(), f.launchEnabled(),
  ])
  return { fee, economics, maxCreatorTaxBps: Number(maxTax), enabled }
}
export function ponsLaunchReadiness(chain) { return curveLaunchReadiness('pons', chain) }
export function geniusLaunchReadiness(chain) { return curveLaunchReadiness('genius', chain) }

/** `launchToken` 的参数。`expectedEconomics` 必须由上面那个函数**现读**后传进来。 */
export function ponsLaunchParams({ name, symbol, logo = '', description = '', socials = {}, creatorFeeRecipient, creatorTaxBps = 0, buybackEnabled = false, expectedEconomics, salt }) {
  return [
    {
      name, symbol, logo, description,
      socials: {
        twitter: socials.twitter || '', telegram: socials.telegram || '', discord: socials.discord || '',
        website: socials.website || '', farcaster: socials.farcaster || '',
      },
      creatorFeeRecipient, creatorTaxBps, buybackEnabled, expectedEconomics,
      salt: salt || window.ethers.hexlify(window.ethers.randomBytes(32)),
    },
    0n,                                   // launchConfigId：当前配置只有 0
    window.ethers.ZeroAddress,            // pairToken：原生 ETH 计价
    [],                                   // snipeTaxExemptions
  ]
}

export async function curveProvider(family, chain = CHAIN) {
  const cfg = curveSite(family, chain)
  if (!cfg || !window.ethers) return null
  return new window.ethers.Contract(cfg.factory, PONS_FACTORY_ABI, provider(chain))
}
export async function pons(chain = CHAIN) { return curveProvider('pons', chain) }

/**
 * 这个地址是不是它发的？是的话把它那一套事实读回来（曲线、税率、毕业线、进度）。
 * **不是**就回 `{ exists: false }` —— 页面据此说"这不是它发的"，而不是硬套。
 */
export async function curveLaunchInfo(family, token, chain = CHAIN) {
  const c = await curveProvider(family, chain)
  if (!c) return { exists: false }
  const l = await c.getLaunchedToken(token)
  if (!l.exists) return { exists: false }
  const [reserves, fee, enabled] = await Promise.all([
    new window.ethers.Contract(l.curve, ['function getReserves() view returns (uint256,uint256)'], provider(chain)).getReserves().catch(() => null),
    c.launchFee().catch(() => null),
    c.launchEnabled().catch(() => null),
  ])
  return {
    exists: true,
    curve: l.curve, deployer: l.deployer, creatorFeeRecipient: l.creatorFeeRecipient,
    pairToken: l.pairToken, graduationThreshold: l.graduationThreshold,
    creatorTaxBps: Number(l.creatorTaxBps), buybackEnabled: l.buybackEnabled,
    phase: Number(l.phase),                                     // 0=曲线上 1=已扫 2=已建池 3=已救援
    reserves: reserves ? { quote: reserves[0], token: reserves[1] } : null,
    launchFee: fee, launchEnabled: enabled,
  }
}
export function ponsLaunchInfo(token, chain = CHAIN) { return curveLaunchInfo('pons', token, chain) }
export function geniusLaunchInfo(token, chain = CHAIN) { return curveLaunchInfo('genius', token, chain) }

/** 一笔发射交易的收据 → 新代币（工厂自己的 `TokenLaunched`，不是 `LaunchedV2`）。 */
export function curveTokenFromReceipt(receipt, family, chain) {
  const f = curveFactory(family, chain)
  if (!f) return null
  for (const log of receipt?.logs || []) {
    try {
      const p = f.interface.parseLog({ topics: [...log.topics], data: log.data })
      if (p && p.name === 'TokenLaunched') return p.args
    } catch { /* 不是它的事件 */ }
  }
  return null
}
export function ponsTokenFromReceipt(receipt, chain) { return curveTokenFromReceipt(receipt, 'pons', chain) }

/* ── Clanker（Base + Robinhood Chain）────────────────────────────────────
 *
 * 纯链上、**无后端无 key**：钱包直调 v4 工厂 `deployToken(DeploymentConfig)`，一笔交易里
 * 建币 + 建 Uniswap V4 池 + **初始流动性永久锁**（它的 locker 没有撤池函数）+ 狙击拍卖模块。
 * **发射免费**（只付 gas，~4.65M ≈ 几美分）；LP 费率由发射者自己选（我们默认 1%/1%）。
 *
 * 它家官方 SDK（clanker-sdk，MIT）就是"钱包直发"，24h 192 笔里 68 笔 context 写着 SDK ——
 * 链上实证过"非官方前端可用"。地址表来自 SDK 的 clankers.ts；下面的模块地址与两个
 * 数据 blob 的编码**全部来自各自链上的真实发射交易**（逐字节 roundtrip 验过）：
 *   · Base 样本 OCEAN SKY `0x6247d40f…`（5 段 Project 仓位、带 vault 扩展）
 *   · 4663 样本 `0x717e70cc…`（1 段仓位、带 devbuy）
 * **两条链的 hook / locker / mevModule / 配对 WETH 都不同**（逐链照抄，别跨链复用）。
 *
 * ⚠ 中心化风险（页面小字如实写）：hook/locker/mevModule 都是工厂 owner 的白名单，
 *   owner 还能 `setDeprecated(true)` 一键停发。
 * ⚠ 发射后有**狙击拍卖期**（~22 秒，之后 15 秒内衰减费 66%→4%）—— 页面要提示别在这期间买。
 * ⚠ `originatingChainId` 必须 == 部署链 id；不带扩展时 `value` 必须恰好是 0。
 */
export const CLANKER = {
  8453: {
    factory: '0xE85A59c628F7d27878ACeB4bf3b35733630083a9',
    hook: '0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC',
    locker: '0xffA37784D619F228D8B379d287a4D7282e500762',
    mevModule: '0xebB25BB797D82CB78E1bc70406b13233c0854413',
    paired: '0x4200000000000000000000000000000000000006',        // WETH
    tick: -230400, tickSpacing: 200,
    positions: [                                                   // 5 段 Project（真实样本）
      { lower: -230400, upper: -214000, bps: 1000 },
      { lower: -214000, upper: -155000, bps: 5000 },
      { lower: -202000, upper: -155000, bps: 1500 },
      { lower: -155000, upper: -120000, bps: 2000 },
      { lower: -141000, upper: -120000, bps: 500 },
    ],
  },
  4663: {
    factory: '0xD3f2cC1731b7Fd17f28798835C2E02f0a1839A94',
    hook: '0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc',
    locker: '0xE4910b09709423aFafD995dD76D8A81CF9134A09',
    mevModule: '0xEA1Fe197dF140e5d88fC6B49f2d21Ea05092299e',
    paired: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',        // 4663 上的 WETH
    tick: -230400, tickSpacing: 200,
    positions: [                                                   // 1 段（真实样本）
      { lower: -230400, upper: -120000, bps: 10000 },
    ],
  },
}

export const CLANKER_ABI = [
  'function deployToken(((address tokenAdmin, string name, string symbol, bytes32 salt, string image, string metadata, string context, uint256 originatingChainId) tokenConfig, (address hook, address pairedToken, int24 tickIfToken0IsClanker, int24 tickSpacing, bytes poolData) poolConfig, (address locker, address[] rewardAdmins, address[] rewardRecipients, uint16[] rewardBps, int24[] tickLower, int24[] tickUpper, uint16[] positionBps, bytes lockerData) lockerConfig, (address mevModule, bytes mevModuleData) mevModuleConfig, (address extension, uint256 msgValue, uint16 extensionBps, bytes extensionData)[] extensionConfigs) deploymentConfig) payable returns (address tokenAddress)',
  'function deprecated() view returns (bool)',
  'event TokenCreated(address msgSender, address indexed tokenAddress, address indexed tokenAdmin, string tokenImage, string tokenName, string tokenSymbol, string tokenMetadata, string tokenContext, int24, address, bytes32, address, address, address, uint256, address[])',
]

/**
 * Clanker v4 的 dev-buy 扩展地址（逐链不同）。后半段 `extensionData` 是一个
 * `(poolKey, uint128 amountOutMin, address recipient)` —— 用 WETH 计价时 poolKey 全零、
 * recipient = 创建者。4663 的地址在真实交易 `0x410a6320…` 里逐字节核对过。
 */
export const CLANKER_DEVBUY = {
  8453: '0x1331f0788F9c08C8F38D52c7a1152250A9dE00be',
  4663: '0xa27b1986e5c7e5371Cb6507f87918fBD0302fF5a',
}

export function clankerFactory(chain, signerOrProvider) {
  const cfg = CLANKER[chain?.id]
  if (!cfg || !window.ethers) return null
  return new window.ethers.Contract(cfg.factory, CLANKER_ABI, signerOrProvider || provider(chain))
}

/**
 * DeploymentConfig 的四个 `bytes` 字段各有讲究（都在真实交易上逐字节对过）：
 *   · `poolData` / `lockerData` 必须是**带外层 offset 的单 tuple**（裸 tuple 会少一个 0x20 字、直接 revert）；
 *   · `feeData` 是买卖两侧费率（uniBps，1e6 = 100%，1% = 10000）；
 *   · `mevModuleData` 是 SniperAuctionV2 的三个数（起拍费/终费/衰减秒数），真实样本就是这三个。
 * `lpFeeBps` 用 1e6 制；`rewardRecipients` 只放创建者自己（我们**不抽**）。
 */
export function clankerDeployParams(chain, { name, symbol, image = '', description = '', socials = {}, lpFeeBps = 10000, tokenAdmin, devBuy = 0n }) {
  const cfg = CLANKER[chain?.id]
  if (!cfg) return null
  const ac = window.ethers.AbiCoder.defaultAbiCoder()
  const Z = window.ethers.ZeroAddress
  const feeData = ac.encode(['uint24', 'uint24'], [lpFeeBps, lpFeeBps])
  const poolData = ac.encode(['tuple(address,bytes,bytes)'], [[Z, '0x', feeData]])
  const lockerData = ac.encode(['tuple(uint8[])'], [[[1]]])           // 1 = 手续费收 WETH
  const mevData = ac.encode(['uint24', 'uint24', 'uint256'], [666777, 41673, 15])
  const urls = []
  if (socials.website) urls.push({ platform: 'website', url: socials.website })
  if (socials.twitter) urls.push({ platform: 'x', url: socials.twitter })
  /* 首买扩展：msgValue 必须**恰好**等于扩展里的金额（合约会拿它和 msg.value 对比），
     所以调用方传的 value 也要是同一个 devBuy。0 = 不带扩展、value 必须为 0。 */
  const extensionConfigs = []
  if (devBuy > 0n) {
    const ext = CLANKER_DEVBUY[chain.id]
    if (!ext) throw new Error('Clanker dev buy is not wired up on this chain.')
    extensionConfigs.push({
      extension: ext,
      msgValue: devBuy,
      extensionBps: 0,
      extensionData: ac.encode(
        ['tuple(address,address,uint24,int24,address)', 'uint128', 'address'],
        [[Z, Z, 0, 0, Z], 0n, tokenAdmin],
      ),
    })
  }
  return {
    tokenConfig: {
      tokenAdmin,
      name, symbol,
      salt: window.ethers.ZeroHash,                                   // 合约层没有 vanity 要求（尾号好看是它家前端自己的事）
      image,                                                          // 就是一个 URL 字符串，链上零校验
      metadata: JSON.stringify({ description, socialMediaUrls: urls, auditUrls: [] }),
      context: JSON.stringify({ interface: 'oaken.one', platform: '', messageId: '', id: '' }),
      originatingChainId: BigInt(chain.id),                           // ⚠ 必须等于部署链 id
    },
    poolConfig: { hook: cfg.hook, pairedToken: cfg.paired, tickIfToken0IsClanker: cfg.tick, tickSpacing: cfg.tickSpacing, poolData },
    lockerConfig: {
      locker: cfg.locker,
      rewardAdmins: [tokenAdmin], rewardRecipients: [tokenAdmin], rewardBps: [10000],
      tickLower: cfg.positions.map((p) => p.lower),
      tickUpper: cfg.positions.map((p) => p.upper),
      positionBps: cfg.positions.map((p) => p.bps),
      lockerData,
    },
    mevModuleConfig: { mevModule: cfg.mevModule, mevModuleData: mevData },
    extensionConfigs,                                              // 不带扩展时 value 必须恰好是 0
  }
}

/** 一笔 Clanker 发射交易的收据 → 新代币（`TokenCreated`，indexed: tokenAddress/tokenAdmin）。 */
export function clankerTokenFromReceipt(receipt, chain) {
  const f = clankerFactory(chain)
  if (!f) return null
  for (const log of receipt?.logs || []) {
    try {
      const p = f.interface.parseLog({ topics: [...log.topics], data: log.data })
      if (p && p.name === 'TokenCreated') return p.args
    } catch { /* 不是它的事件 */ }
  }
  return null
}

/* ── Flap（第三方的发射台：BSC / Robinhood / Base）────────────────────────
 *
 * 它的 Portal 合约上一个 `newTokenV6` 全包：**税币与普通币是同一个函数**，靠税率区分
 * （普通 = buyTaxRate/sellTaxRate/taxDuration 全 0）。创建费实测 0（`value: 0` 就能发）。
 *
 * 我们**能**编码它 —— BSC 有真实 EOA 直调的交易当模板（`0x04216819…`）；
 * **4663 与 Base 的地址与入口来自它家官方文档**（`docs.flap.sh` 的
 * robinhood-chain-integration-guide + deployed-contract-addresses），两条都在真链上
 * `eth_call` 验过（4663 两条路、Base 税币；Base 没开非税）。
 *
 * ⚠ 它也可以改成"要签名"（合约里有 PermissionlessCreateDisabled / InvalidSigner），
 *   所以这条路线上线后要盯着：一旦开始 revert，就要如实告诉用户"Flap 关了公开创建"。
 */
export const FLAP = {
  /**
   * `portal`   —— 创建入口（BSC 链上 `version()` 回 v5.24.0 验证过）
   * 每条链的币都是 EIP-1167 最小代理（45 字节），但**实现、入口、地址尾数**逐链不同，
   * 用错哪一组，合约都回 `VanityAddressRequirementNotMet`（BSC 上两种我们都踩过）：
   *   · BSC：`standard` `newTokenV7`（实现 `0x88881b6f…`，尾数 8888）·
   *          `tax` `newTokenV6`（实现 `0x024f1829…`，尾数 7777）
   *   · 4663：`standard` `newTokenV5`（实现 `0x88882688…`，尾数 8888）·
   *           `tax` `newTokenV6`（实现 `0x7777C874…`，尾数 7777）
   *   · 8453：**只有税币**（官方地址表里没有非税实现，`taxOnly: true`）——
   *           `tax` `newTokenV6`（实现 `0x777782e7…`，尾数 7777）
   * `migrator` 是每条路的毕业去向（枚举：0=V3 / 1=V2 / 2=V4 / 3=Pancake Infinity）——
   * BSC 非税=3（Pancake Infinity）、其余全=1（V2）。4663 上 V3/V4 会被 `FeatureDisabled()` 拒。
   * `initHash` 是 `keccak256(45 字节代理的初始化代码)`，由实现地址推出来 —— 已用 BSC 的
   * 已知值校准过（两个都一字不差），再拿去 4663/Base 预测地址。
   */
  56: {
    portal: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',
    standard: { entry: 'newTokenV7', vanity: '8888', migrator: 3, initHash: '0x6503c030e7b94b9e67e0acf9c39cef218e663fef69b9cb594d23471f78c2688a' },
    tax: { entry: 'newTokenV6', vanity: '7777', migrator: 1, initHash: '0x2f7f413fcc6c3812c665c15bd4a012e663f567d626112a81d401066fd5a771b4' },
  },
  4663: {
    portal: '0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09',
    standard: { entry: 'newTokenV5', vanity: '8888', migrator: 1, initHash: '0x5b6a27c09bf7c71a9c25a1288abbd0f6458023909488c231e84dc360b5d02eb4' },
    tax: { entry: 'newTokenV6', vanity: '7777', migrator: 1, initHash: '0x6ce33cede557fe3331031c87bf9be28f493a6086cdc8770ac0a4c7dd7320dea7' },
  },
  8453: {
    portal: '0x0000BC1c4fD15Dd79029AF8F5d77D68ae4490000',
    taxOnly: true,
    tax: { entry: 'newTokenV6', vanity: '7777', migrator: 1, initHash: '0xf7fb8b8a42a24b2ea0bcb979279a43d5df7c9f65ab6ec7f2be1db9115b3b5eff' },
  },
}

export const FLAP_ABI = [
  'function newTokenV5((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint16 taxRate,uint8 migratorType,address quoteToken,uint256 quoteAmt,address beneficiary,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint8 lpFeeProfile,uint64 taxDuration,uint64 antiFarmerDuration,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint256 minimumShareBalance) p) payable returns (address token)',
  'function newTokenV6((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint8 migratorType,address quoteToken,uint256 quoteAmt,address beneficiary,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint8 lpFeeProfile,uint16 buyTaxRate,uint16 sellTaxRate,uint64 taxDuration,uint64 antiFarmerDuration,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint256 minimumShareBalance,address dividendToken,address commissionReceiver,uint8 tokenVersion) p) payable returns (address token)',
  'function newTokenV7((string name,string symbol,string meta,uint8 dexThresh,bytes32 salt,uint8 migratorType,address quoteToken,uint256 quoteAmt,bytes permitData,bytes32 extensionID,bytes extensionData,uint8 dexId,uint16 buyTaxRate,uint16 sellTaxRate,uint64 taxDuration,uint64 antiFarmerDuration,address commissionReceiver,uint8 tokenVersion,(uint8 feeType,uint16 bps,address marketingAddress,address dividendToken,uint256 minimumShareBalance)[4] feeConfigs) p) payable returns (address token)',
  'event TokenCreated(uint256 ts, address creator, uint256 nonce, address token, string name, string symbol, string meta)',
]

export function flap(chain, signerOrProvider) {
  const cfg = FLAP[chain?.id]
  if (!cfg) return null
  return new window.ethers.Contract(cfg.portal, FLAP_ABI, signerOrProvider || provider(chain))
}

/**
 * 挖一个 salt，使新代币地址以对应的**尾数**结尾。
 *
 * ⚠ **必须分片**：整段同步跑是 1.2–4.2 秒的纯 CPU 循环（实测 29k–97k 次尝试），
 * 在浏览器里那几秒**整页冻住** —— 连"正在挖地址"那句话都画不出来，用户以为卡死了。
 * 每 4000 次让出一次主线程（≈160ms），页面照常重画、按钮照常响应。
 *
 * `kind`：`'standard'`（普通币，尾数 8888）或 `'tax'`（税币，尾数 7777）——
 * 两种代理不同，哈希也不同，取错会被 `VanityAddressRequirementNotMet` 拒。
 */
export async function mineFlapSalt(chain, kind = 'standard', { attempts = 800_000, chunk = 4000, onProgress } = {}) {
  const cfg = FLAP[chain?.id]
  const track = cfg && cfg[kind]
  if (!track) return null
  for (let done = 0; done < attempts; done += chunk) {
    for (let i = 0; i < chunk; i++) {
      const salt = window.ethers.hexlify(window.ethers.randomBytes(32))
      const addr = window.ethers.getCreate2Address(cfg.portal, salt, track.initHash)
      if (addr.toLowerCase().endsWith(track.vanity)) return { salt, address: addr, kind }
    }
    if (onProgress) onProgress(done + chunk)
    await new Promise((r) => setTimeout(r, 0))
  }
  return null
}

/**
 * 把表单变成**非税那条路**的参数 —— 入口和形状**逐链不同**（见 `FLAP` 上面的注释）：
 *   · BSC  → `newTokenV7`（Pancake Infinity 毕业；那组默认值来自一笔真实交易 `0x8eec296a…`，
 *            不是猜的 —— 猜的代价我们付过：`migratorType` 传 1 会被回 `NewTokenV7RuleViolation(7)`）
 *   · 4663 → `newTokenV5`（官方 Robinhood 指南给的入口，`taxRate = 0` 即非税；V2 毕业到 Uniswap V2）
 *
 * 两条都要求**同样的 vanity 地址**（尾数 8888，挖 salt 那步已经保证）。
 * 税币走的是另外的入口（`newTokenV6`），见 `flapTaxParams`。
 */
export function flapParams(chain, { name, symbol, meta = '', salt, beneficiary, quoteAmt = 0n }) {
  const track = FLAP[chain?.id]?.standard
  const migratorType = track ? track.migrator : 1 // Pancake Infinity 只在 BSC 与非税那条
  if (track && track.entry === 'newTokenV5') {
    // V5：一个平铺结构（没有 feeConfigs / commissionReceiver / tokenVersion）
    return {
      name, symbol, meta,
      dexThresh: 1,
      salt,
      taxRate: 0,
      migratorType,                          // V2（Robinhood 上 V3/V4 会被 FeatureDisabled 拒）
      quoteToken: window.ethers.ZeroAddress, // 原生币计价
      quoteAmt,                              // 发射时首买（wei）；调用方还要把同一个数放进 value
      beneficiary: beneficiary || window.ethers.ZeroAddress, // 非税币的 LP 费认领人（官方示例=创建者）
      permitData: '0x',
      extensionID: window.ethers.ZeroHash,
      extensionData: '0x',
      dexId: 0,
      lpFeeProfile: 0,
      taxDuration: 0,
      antiFarmerDuration: 86400,             // 1 天（官方指南示例值）
      mktBps: 10000, deflationBps: 0, dividendBps: 0, lpBps: 0,
      minimumShareBalance: 0n,
    }
  }
  return {
    name, symbol, meta,
    dexThresh: 1,
    salt,
    migratorType,                          // Pancake Infinity（BSC）
    quoteToken: window.ethers.ZeroAddress, // 原生币计价
    quoteAmt,                              // 发射时首买（wei）；调用方还要把同一个数放进 value
    permitData: '0x',                      // 空：ERC-20 计价才要后端签名，这里不要
    extensionID: window.ethers.ZeroHash,
    extensionData: '0x',
    dexId: 0,
    buyTaxRate: 0,
    sellTaxRate: 0,
    taxDuration: 0,
    antiFarmerDuration: 2592000,           // 30 天（真实样本就是这个值）
    commissionReceiver: window.ethers.ZeroAddress,
    tokenVersion: 7,
    // 真实样本：第一档 = 分红档、全部手续费、最低持仓 1e22；其余三档留空
    feeConfigs: [
      [2, 10000, window.ethers.ZeroAddress, window.ethers.ZeroAddress, 10000000000000000000000n],
      [0, 0, window.ethers.ZeroAddress, window.ethers.ZeroAddress, 0n],
      [0, 0, window.ethers.ZeroAddress, window.ethers.ZeroAddress, 0n],
      [0, 0, window.ethers.ZeroAddress, window.ethers.ZeroAddress, 0n],
    ],
  }
}

/** 一笔 Flap 发射交易的收据 → 新代币地址（`TokenCreated` 里的 `token`）。 */
/**
 * **平台费收款地址**（Flap 税币的 `commissionReceiver`）—— 2026-10-13 owner 拍板开。
 *
 * 机制是 2026-10-13 在真链上验穿的（README §五之三十）：Flap 按**有效税率**自己算
 * `commissionBps = 60000 / taxRateBps`，所以这笔钱恒等于**成交额的 0.06%** —— 买、卖都收，
 * 原生 BNB，直接进下面这个地址，从创建者的分税里出，我们选不了费率、只能选给谁。
 * 设 `0x0` = 关（创建者拿全额分成）。
 *
 * ⚠ 只对**税币 V3**（`tokenVersion = 6` → `newTokenV6`）有效；普通币（`newTokenV7`）合约
 *   要求这个字段必须是 `0x0`。**换收款地址就改这一行。**
 */
export const FLAP_FEE_RECEIVER = '0x21b4114C6038d8927e25d6B6F6fA436d1947Da72' // 临时用部署钱包；owner 给正式收款地址后换掉

/**
 * **税币（`newTokenV6`）** 的参数：买卖税 + 税期，外加**分税四件套**（必须合计 10000 bps）。
 *
 * 形状从**一笔真实的 Flap 税币发射**（BSC `0x04216819…`）逐字段读出，再用 `eth_call` 逐项验过：
 * 税率任意（300/300、500/500 都过）、分税合计不是 10000 会被 `InvalidTaxDistribution` 拒、
 * 0/0 会被 `Error("V3 tax: must have tax rate")` 拒（**税币必须有税**）。
 *
 * `commissionReceiver` 默认收进 `FLAP_FEE_RECEIVER`（见上，0.06% 的平台费）。
 */
export function flapTaxParams({
  name, symbol, meta = '', salt, beneficiary, quoteAmt = 0n,
  buyTaxBps = 300, sellTaxBps = 300,
  mktBps = 7800, deflationBps = 600, dividendBps = 800, lpBps = 800,
  minimumShareBalance = 10000000000000000000000n,
  dividendToken, commissionReceiver = FLAP_FEE_RECEIVER,
}) {
  return {
    name, symbol, meta,
    dexThresh: 1,
    salt,
    migratorType: 1,
    quoteToken: window.ethers.ZeroAddress,
    quoteAmt,                                   // 发射时首买（wei）；value 必须同额
    beneficiary,
    permitData: '0x',
    extensionID: window.ethers.ZeroHash,
    extensionData: '0x',
    dexId: 0,
    lpFeeProfile: 0,
    buyTaxRate: buyTaxBps,
    sellTaxRate: sellTaxBps,
    taxDuration: 3153600000,                    // 100 年（真实样本就是这个值）
    antiFarmerDuration: 2592000,                // 30 天
    mktBps, deflationBps, dividendBps, lpBps,
    minimumShareBalance,
    dividendToken: dividendToken || window.ethers.ZeroAddress,
    commissionReceiver: commissionReceiver || window.ethers.ZeroAddress,
    tokenVersion: 6,
  }
}

export function flapTokenFromReceipt(receipt, chain) {
  const c = flap(chain)
  if (!c) return null
  for (const log of receipt?.logs || []) {
    try {
      const p = c.interface.parseLog({ topics: [...log.topics], data: log.data })
      if (p && p.name === 'TokenCreated') return p.args
    } catch { /* 不是它的事件 */ }
  }
  return null
}

/* ── four.meme（第三方的发射台，BSC）────────────────────────────────────────
 *
 * 它的发射是**两半**，缺一不可：
 *   ① 创建的 `{args, signature}` 由**它后端签发** —— 第三方站点造不出来，
 *      算法在它服务器上。浏览器也直连不了：这个接口要 `meme-web-access` 头，
 *      而它的 CORS 预检**不放行这个头**。
 *   ② 链上的 `createToken(args, signature)` 由**用户的钱包**发 —— 我们的表单
 *      负责把①拿到的那一对原样交给它。
 *
 * 所以"站内发射"在这里是：**我们的表单 + 它的签发 + 你的钱包**。会话 token 走
 * 我们自己的 `/api/fourmeme/*` 中继（见 `src/routes.mjs` 那段注释），只交给它一家。
 *
 * ⚠ 它的 API **按来源地区拒绝**：受限地区拿到的是一张 HTML（不是 JSON）。
 *   中继在那种回答上会抛一句人话，别让它烂成"JSON 解析失败"。
 */
export const FOURMEME = {
  56: {
    relay: '/api/fourmeme',
    tokenManager: '0x5c952063c7fc8610ffdb798152d69f0b9550762b',
    createUrl: 'https://four.meme/en/create-token',
    /** 它前端自己用的分组名单（`chunk 404nnjp45llgh.js`），多一个少一个都会被拒。 */
    labels: ['Meme', 'AI', 'Defi', 'Games', 'Infra', 'De-Sci', 'Social', 'Depin', 'Charity', 'Others'],
  },
}

export const FOURMEME_TM_ABI = [
  'function createToken(bytes args, bytes signature) payable',
  'function _launchFee() view returns (uint256)',
  /**
   * ⚠ 事件形状是**现版** manager 发的（topic0 `0x396d5e90…`）——在一笔真实发射的
   * 收据上逐字段解过（creator/token/name/symbol/totalSupply 全对上）。
   * 老 chunk 里那条 `TokenCreate(uint256,address,address)` 是**上一代合约**的，
   * 拿它解现在的收据一条都解不出来（踩过：页面正常、地址读不到）。
   * 后两个 uint 在那笔里都是 0（我们没预买、发射费也是 0），名字是推测的 —— 只读 `token`。
   */
  'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchFee, uint256 presaleQuote)',
]

export function fourMemeManager(chain, signerOrProvider) {
  const cfg = FOURMEME[chain?.id]
  if (!cfg || !window.ethers) return null
  return new window.ethers.Contract(cfg.tokenManager, FOURMEME_TM_ABI, signerOrProvider || provider(chain))
}

/**
 * 它家 API 的错误 → 一句人话。**它自己的 msg 永远带上**，别藏 ——
 * 藏了就会把 `-1013 Too many requests, banned for 15 minutes` 说成"配置读不到"，
 * 而那不是同一件事（2026-10-13 实测：线上中继就是被这条挡住的）。
 * 非 JSON 的回答（地区封锁页）在 `fmApi` 里已经翻过了。
 */
function fmUpstreamError(data, fallback) {
  const msg = data && data.msg ? String(data.msg) : ''
  if (msg) {
    if (/too many requests|banned/i.test(msg)) {
      return 'four.meme rate-limited our server ("' + msg + '") — its anti-abuse refuses shared server addresses. '
        + 'You can launch on four.meme directly and come back: the box below still takes your token.'
    }
    return msg
  }
  return fallback
}

/**
 * 中继调用。`token` 就是登录换来的 `user_token`（`meme-web-access` 头）。
 * 非 JSON 的回答（地区封锁页）在这里翻成人话 —— 它长得像 200，不翻就会烂成
 * "Unexpected token <"。
 */
export async function fmApi(chain, path, { method = 'GET', body, token } = {}) {
  const cfg = FOURMEME[chain?.id]
  if (!cfg) throw new Error('four.meme is not wired up on this chain')
  const headers = {}
  if (body != null) headers['content-type'] = 'application/json'
  if (token) headers['meme-web-access'] = token
  let res
  try {
    res = await fetch(cfg.relay + '/' + path, {
      method, headers,
      body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    })
  } catch (e) {
    const err = new Error('Could not reach our own relay for four.meme — is the site served by OAKEN?')
    err.network = true       // 只有网络层失败才值得重试（见 fmUpload）；HTTP/业务拒绝不重试
    throw err
  }
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch {
    // 受限地区/被封的出口 IP，它回的都是**一张 HTML** —— 说人话，并指出还能走哪条路
    throw new Error('four.meme refused our server by region (its answer is a web page, not JSON). '
      + 'You can launch on four.meme directly and come back: the box below still takes your token to the lock page.')
  }
  return { status: res.status, data }
}

/**
 * 登录：`nonce/generate` → 让钱包**签一句文本** → `login/dex` 换 `user_token`（1 天）。
 * 签的是文本不是交易 —— 没有 gas，也没有链上动作。
 */
export async function fmLogin(chain, signer) {
  const addr = await signer.getAddress()
  const a = await fmApi(chain, 'v1/private/user/nonce/generate', {
    method: 'POST',
    body: { accountAddress: addr, verifyType: 'LOGIN', networkCode: 'BSC' },
  })
  if (a.data?.code !== 0 || !a.data?.data) throw new Error(fmUpstreamError(a.data, 'four.meme would not hand out a nonce'))
  const signature = await signer.signMessage('You are sign in Meme ' + a.data.data)
  const b = await fmApi(chain, 'v1/private/user/login/dex', {
    method: 'POST',
    body: {
      region: 'WEB', langType: 'EN', loginIp: '', inviteCode: '',
      verifyInfo: { address: addr, networkCode: 'BSC', signature, verifyType: 'LOGIN' },
      walletName: 'OAKEN',
    },
  })
  if (b.data?.code !== 0 || !b.data?.data) throw new Error(fmUpstreamError(b.data, 'four.meme login failed'))
  return b.data.data
}

/** 公共配置（不用登录）。创建时 `raisedToken` 要**原样**回传它给出的那一条。 */
export async function fmQuote(chain) {
  const { data } = await fmApi(chain, 'v1/public/config')
  if (data?.code !== 0 || !Array.isArray(data.data) || !data.data.length) throw new Error(fmUpstreamError(data, 'four.meme config came back wrong'))
  const published = data.data.filter((x) => x.status === 'PUBLISH')
  const list = published.length ? published : data.data
  return list.find((x) => x.symbol === 'BNB') || list[0]
}

/** 图片：它家的接口收 base64（`{_upload, fileBase64, fileName}`），回一个 URL。 */
export async function fmUpload(chain, token, base64) {
  const call = () => fmApi(chain, 'v1/private/token/upload', {
    method: 'POST', token,
    body: { _upload: true, fileBase64: base64, fileName: 'logo.png' },
  })
  let out
  try {
    out = await call()
  } catch (e) {
    /* 图片 base64 是个大 body，第一次请求偶尔被边缘/代理掐断（"Failed to fetch"）。
       同一份 body 重发一次即可；只重试网络层失败。 */
    if (!e || !e.network) throw e
    await new Promise((r) => setTimeout(r, 400))
    out = await call()
  }
  const { data } = out
  if (data?.code !== 0 || !data?.data) throw new Error(fmUpstreamError(data, 'four.meme rejected the image'))
  return data.data
}

/**
 * 创建 payload —— 字段是**逐个照抄**它自己前端发的那一份（`chunk 404nnjp45llgh.js` +
 * agent 工具里那份可读实现）。少一个字段就是一次 `code !== 0` 的拒绝，
 * 而它的报错只说一句"Token name limit"之类，查不出缺了哪个。
 */
export function fmCreatePayload({ name, shortName, desc, imgUrl, quote, label, socials = {}, tax, preSale = '0' }) {
  const payload = {
    name, shortName, desc,
    totalSupply: Number(quote.totalAmount ?? 1e9),
    raisedAmount: Number(quote.totalBAmount ?? 24),
    saleRate: Number(quote.saleRate ?? 0.8),
    reserveRate: 0,
    imgUrl,
    raisedToken: quote,
    launchTime: Date.now(),
    funGroup: false,
    label,
    lpTradingFee: 0.0025,
    preSale: String(preSale || '0'),   // 首买金额，单位是**原生币的十进制字符串**（如 "0.001"）
    clickFun: false,
    symbol: quote.symbol,
    dexType: 'PANCAKE_SWAP',
    rushMode: false,
    onlyMPC: false,
    feePlan: false,
  }
  if (socials.web) payload.webUrl = socials.web
  if (socials.twitter) payload.twitterUrl = socials.twitter
  if (socials.telegram) payload.telegramUrl = socials.telegram
  if (tax) {
    /**
     * ⚠ 字段形状照**当前** web 流程的 `tokenTaxInfo`（chunk `404nnjp45llgh.js`）：
     * 买卖税率是**分开的两个字段**（`feeRate` / `feeRateSell`，1 / 3 / 5 / 10），
     * 另有 `giggleCharityRate` / `binanceCharityRate` 两个慈善份（固定 0）。
     * **少 `feeRateSell` 会被回 "Data sent for parameter fee rate sell is not valid"**
     * （2026-10-13 实测 —— 老一版 agent 代码里没有这个字段，照抄它会踩）。
     */
    payload.tokenTaxInfo = {
      feeRate: tax.feeRate,
      feeRateSell: tax.feeRateSell ?? tax.feeRate,
      giggleCharityRate: 0,
      binanceCharityRate: 0,
      burnRate: tax.burn, divideRate: tax.divide, liquidityRate: tax.liquidity, recipientRate: tax.recipient,
      recipientAddress: tax.recipientAddress || '',
      minSharing: tax.minSharing ?? 10000,
    }
  }
  return payload
}

/** 拿签发：`{tokenId, createArg, signature, bamount, tamount}`。 */
export async function fmCreate(chain, token, payload) {
  const { data } = await fmApi(chain, 'v1/private/token/create', { method: 'POST', token, body: payload })
  if (data?.code !== 0 || !data?.data?.createArg) throw new Error(fmUpstreamError(data, 'four.meme refused the create'))
  return data.data
}

/** 一笔 four.meme 发射交易的收据 → 新代币地址（TokenManager 的 `TokenCreate`）。 */
export function fmTokenFromReceipt(receipt, chain) {
  const c = fourMemeManager(chain)
  if (!c) return null
  for (const log of receipt?.logs || []) {
    try {
      const p = c.interface.parseLog({ topics: [...log.topics], data: log.data })
      if (p && p.name === 'TokenCreate') return p.args
    } catch { /* 不是它的事件 */ }
  }
  return null
}

/* ── 仓位锁（Uniswap V3/V4 的 NFT 仓位）───────────────────────────────────
 *
 * V2 的 LP 是 ERC-20，进金库；V3/V4 的仓位是 **ERC-721**，进 `PositionLock`
 * （一个单独的小合约，见 contracts/contracts/PositionLock.sol）。
 *
 * `POSITION_MANAGERS` 是**链上验过**的仓位管理器地址 —— 4663 上 Uniswap V4 的
 * PositionManager 不在规范地址上，是 Pons 的毕业执行器字节码里挖出来、再逐个
 * getter 对过（name()/symbol()/poolManager()/permit2()）。
 */
export const POSITION_LOCK = '0xfC9A43c90e0E0d548D95cEf3C77fce802806CbA9'

export const POSITION_MANAGERS = {
  4663: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
}

export const POSITION_LOCK_ABI = [
  'function lockPosition((address nft,uint256 tokenId,address beneficiary,uint64 unlockTime,bool revocable,bytes32 label) p) returns (uint256)',
  'function release(uint256 lockId)',
  'function reclaim(uint256 lockId)',
  'function getLock(uint256 lockId) view returns (tuple(address nft,uint64 unlockTime,bool revocable,bool released,address creator,uint64 createdAt,address beneficiary,uint256 tokenId,bytes32 label))',
  'function isReleasable(uint256 lockId) view returns (bool)',
  'function nextLockId() view returns (uint256)',
]

export function positionLock(chain, signerOrProvider) {
  return new window.ethers.Contract(POSITION_LOCK, POSITION_LOCK_ABI, signerOrProvider || provider(chain))
}

/** 这条链上已验证的仓位管理器地址（没有就回 null —— 表单留空让用户自己填）。 */
export function positionManagerOf(chain) {
  return POSITION_MANAGERS[chain?.id] || null
}

/** bytes32 标签 → 字符串；解不出来（被截断的多字节字符）回空串，不抛。 */
export function labelText(label) {
  try {
    const s = window.ethers.decodeBytes32String(label)
    return s || ''
  } catch { return '' }
}

export const ERC20 = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function name() view returns (string)',
  /* ⚠ `totalSupply` 一直漏在这儿（2026-10-15 抓到）：代币工厂那一列的供应量读的就是它，
     而**未声明的函数名在 ethers 里是同步 TypeError**（不是 reject）——
     写在 `Promise.all([...])` 的数组里就直接抛，整个列表的符号/名称/供应量全变成 "—"，
     连一条错误日志都没有。加函数要给 ABI 加，别忘了这里。 */
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

/* ── 只读 provider（不需要钱包）─────────────────────────────────────────
 * **每条链一个**，按 chain id 缓存 —— 多链之后共用一个 provider 就是拿 A 链的
 * RPC 去问 B 链的合约（表现是"这个地址上没有代码"，而地址其实是对的）。 */
const _providers = new Map();
const _probed = new Set();      // 每条链只探一次（第一次真正用到它时）

/* ── RPC 健康探测与轮换 ─────────────────────────────────────────────────
 * 2026-10-14 外部评审的第一条："前端完全依赖客户端 RPC 实时读取，任何 RPC 超时/限速
 * 都让界面永远卡住"。实测下来的三个事实（都量过）：
 *   · 注册表每条链本来就给了 **2 个 RPC**，而这里以前只取 `rpcs[0]` —— 第一个一挂就整页等；
 *   · ethers 的默认 fetch 超时是 **300 秒**（`_getConnection().timeout`，读回确认过）；
 *   · **把 timeout 设成 10 秒也救不了"连不上的主机"** —— Windows 的 TCP 自己在 21 秒放弃，
 *     期间 fetch 不 abort、ethers 的 timeout 也不触发（实测：设了 10 秒，仍然 21 秒才报
 *     "Failed to fetch"）。所以**别指望请求级超时**。
 *
 * 改成"别去碰坏的"：
 *   ① 页面一打开就**并发探测**每条链的每个 RPC（eth_chainId，4 秒），谁先答用谁，
 *     整场会话记住（sessionStorage）；`Promise.any` 不等奖慢的那个。
 *   ② 某条链读失败时，页面上的**重试按钮**先 `rotateRpc`（轮到下一个 URL）再重建 provider。
 */
const RPC_KEY = 'oaken.rpcbest';
function rpcBest() { try { return JSON.parse(sessionStorage.getItem(RPC_KEY) || '{}'); } catch { return {}; } }
function setRpcBest(id, url) { try { const m = rpcBest(); m[id] = url; sessionStorage.setItem(RPC_KEY, JSON.stringify(m)); } catch { /* 隐私模式 */ } }
export function bestRpc(chain) {
  const id = Number(chain?.id ?? DEFAULT_CHAIN_ID);
  return rpcBest()[id] || (Array.isArray(chain?.rpcs) && chain.rpcs[0]) || chain?.rpc;
}
/** 并发探一遍这条链的 RPC，记住最快的那个。静默失败（探测挂了不影响别的）。 */
export async function probeChain(chain) {
  const urls = ((Array.isArray(chain?.rpcs) && chain.rpcs.length ? chain.rpcs : [chain.rpc]) || []).filter(Boolean);
  if (urls.length < 2) return;
  const winner = await Promise.any(urls.map(async (u) => {
    const r = await fetch(u, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (Number(j.result) !== Number(chain.id)) throw new Error('wrong chain');
    return u;
  })).catch(() => null);
  if (winner) {
    /* ⚠ 这里要比的是 `bestRpc(chain)`（这条链现在用哪个）；`rpcBest()` 是**读整张表**，
       拿它去比永远不等、拿它去 indexOf 永远 -1（轮换会每次都落在同一个 URL 上）。 */
    if (winner !== bestRpc(chain)) { setRpcBest(chain.id, winner); _providers.delete(Number(chain.id)); }
  }
}
/** 轮到下一个 URL（重试按钮用）—— 数组顺序轮转，确定性，不用等探测。 */
export async function rotateRpc(chain) {  const id = Number(chain?.id ?? DEFAULT_CHAIN_ID);
  const urls = ((Array.isArray(chain?.rpcs) && chain.rpcs.length ? chain.rpcs : [chain.rpc]) || []).filter(Boolean);
  if (urls.length < 2) return bestRpc(chain);
  const cur = bestRpc(chain);
  const next = urls[(Math.max(0, urls.indexOf(cur)) + 1) % urls.length];
  setRpcBest(id, next);
  _providers.delete(id);
  return next;
}

/**
 * 链上的"现在"（秒）。**动作门控用它，不用访客的电脑时钟** ——
 * 设备时钟偏几分钟到几天时，Release / Sweep 会明明该亮却一直是灰的
 * （2026-10-17 预售 Finalize 就是被墙钟坑过一次）。缓存 8 秒，别每画一次问一次。
 */
const _nowCache = new Map();
export async function chainNow(chain = CHAIN) {
  const key = Number(chain?.id ?? DEFAULT_CHAIN_ID);
  const hit = _nowCache.get(key);
  if (hit && Date.now() - hit.at < 8000) return hit.ts;
  /**
   * Raw JSON-RPC, **not `provider()`** —— /launch deliberately lazy-loads ethers,
   * so at boot `window.ethers` is undefined and a provider-based read would throw
   * (the catch would silently leave the form on the device clock).
   */
  const r = await fetch(bestRpc(chain), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (j.error || !j.result) throw new Error((j.error && j.error.message) || 'no block');
  const ts = Number(BigInt(j.result.timestamp));
  _nowCache.set(key, { at: Date.now(), ts });
  return ts;
}

/* ── 读链的护栏：超时 → 重试（换端点）→ 如实失败 ────────────────────────
 *
 * 2026-10-15 外部评审的清单第 1 条：**任何 "Reading…" 都必须有尽头**。
 * 现状里每一种"永远转圈"的成因都不一样，所以这里是四件事捆在一起：
 *
 *   ① **超时**：`provider()` 已经在连接层设了 10 秒，但那只治"连上了却不回"的挂
 *      （见上面那段注释：连不上的主机由 Windows 的 TCP 自己在 21 秒放弃）。
 *      这里再包一层 `Promise.race` —— 保证**调用方**拿到的是一个有尽头的 promise。
 *   ② **重试一次**：失败多半是这一个端点这一次的问题，重试前先 `rotateRpc`
 *      换一条 URL 再试（我们自己注册表里每条链都有 2–3 个）。
 *   ③ **短时缓存**：列表类数据 30–60 秒内不重复打 RPC（切筛选、来回翻页、
 *      同一个数字被两处读 —— 都在这一层收敛）。
 *   ④ **统一失败文案 + 重试按钮**：`showReadFail()` 一处实现，各页共用，
 *      文案一致（[[fallback-that-looks-like-real-data]]：读不到就如实说读不到）。
 */

/** 读不到链上数据时**唯一**的那句话（各页不许各写各的）。 */
export const READ_FAILED = 'Could not read from the chain right now — please retry.';

/**
 * 读一次链，带超时与一次重试。失败**抛**（由调用方决定怎么显示），
 * 但保证一定在 `timeout × (retries + 1) + 余量` 之内落定，不会永远挂着。
 */
export async function safeRead(fn, { timeout = 10_000, retries = 1, chain = null, label = '' } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), timeout)),
      ]);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        /* 换一条端点再试 —— 超时/限流几乎都是"这一个 URL 这一次"的问题。
           轮换会把缓存的 provider 丢掉，所以下一轮 fn() 里重新取的 provider 就是新的。 */
        if (chain) { try { await rotateRpc(chain); } catch { /* 只有一条端点就没什么可轮 */ } }
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
  const detail = String((lastError && lastError.message) || lastError || 'unknown error');
  const err = new Error(label ? `${label}: ${detail}` : detail);
  err.cause = lastError;
  throw err;
}

/**
 * 短时缓存。`ttlMs` 默认 45 秒 —— 清单给的区间是 30–60，取中间。
 *
 * ⚠ **只缓存成功**。失败的教训不能缓存：缓存了失败，重试按钮点下去还是那句失败
 * （要缓存失败的话，"重试"就成了一个装饰）。
 * `cacheDrop(prefix)` 是重试按钮该调的第一件事。
 */
const _readCache = new Map();
export async function cachedRead(key, ttlMs, fn) {
  const hit = _readCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  _readCache.set(key, { at: Date.now(), value });
  return value;
}
/** 丢掉匹配前缀的缓存（重试用）。不传前缀就清空 —— 别让它无限长大。 */
export function cacheDrop(prefix = '') {
  if (!prefix) { _readCache.clear(); return; }
  for (const k of [..._readCache.keys()]) if (k.startsWith(prefix)) _readCache.delete(k);
}

/**
 * 统一的"读不到"行 + 重试按钮。渲染进 `host`，点重试前**先轮换 RPC、再清缓存**，
 * 然后交给调用方的 `onRetry`（各页自己知道重画什么）。
 *
 * `detail` 是给愿意看的人看的原文（超时 / HTTP 429 之类），默认折叠着 ——
 * 清单说"可选显示具体错误原因"，所以它存在但不喧宾夺主。
 */
export function showReadFail(host, { what = 'this', detail = '', chain = null, onRetry = null } = {}) {
  if (!host) return null;
  host.innerHTML = '<div class="readfail">'
    + '<b>' + READ_FAILED + '</b>'
    + (detail ? ' <span class="muted" style="font-size:12px">(' + escapeHtml(String(detail).slice(0, 120)) + ')</span>' : '')
    + ' <button class="btn btn-s" type="button" data-readfail-retry>Retry</button>'
    + '</div>';
  const btn = host.querySelector('[data-readfail-retry]');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Retrying…';
    /* 先换端点、再清缓存 —— 顺序反了的话重试会原样命中刚才那份缓存 */
    if (chain) { try { await rotateRpc(chain); } catch { /* 单端点链没什么可轮 */ } }
    cacheDrop();
    if (onRetry) await onRetry();
    else btn.disabled = false;
  };
  return host;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 骨架屏行（表格里那几行灰条）—— 列表页共用，省得每页各写一份。 */
export function skeletonRows(cols, rows = 5, widths = null) {
  const w = widths || Array.from({ length: cols }, () => 45);
  return Array.from({ length: rows }, () =>
    '<tr class="skel-row">' + Array.from({ length: cols }, (_, i) =>
      `<td><div class="skel-bar" style="width:${w[i % w.length]}%"></div></td>`).join('') + '</tr>').join('');
}

/**
 * **到点就放行**的哨兵。配合 `Promise.race([工作, raceTimeout(ms)])` 用：
 * 超时回的是这个符号（**不是抛**），所以调用方可以"先画已经拿到的，其余如实标成没读到"
 * —— 不需要为超时写 try/catch，也不会把整段结果丢掉。
 *
 * 为什么要有它（2026-10-15 实测）：公共 RPC **连上了但不回**时（`mainnet.base.org` 就是
 * 这种），每个读都要走完"10 秒超时 + 换端点重试 10 秒"，而列表页是**逐链串行**的 ——
 * 四条链就是 40 秒起步（实测 /tools/airdrop 42 秒才给出可用状态，用户看到的就是
 * "卡在 Reading…"）。有了它，列表可以给整段设一个总时限：到点就画，没答的链写进失败行。
 */
export const TOO_SLOW = Symbol('too-slow');
export function raceTimeout(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(TOO_SLOW), ms));
}

/**
 * "还在读"的一句话 —— 超过 `ms` 还没画完就出现，**并带一个马上重试的入口**。
 * 用户不该对着一片骨架屏猜是死是活；返回的函数用来收场（拿到了/放弃了都调它）。
 */
export function stillReadingAfter(host, ms = 3500, { what = 'this list', onRetry = null } = {}) {
  if (!host) return () => {};
  const t = setTimeout(() => {
    if (!document.body.contains(host)) return;
    const el = document.createElement('div');
    el.className = 'hint stillreading';
    el.innerHTML = '<span class="spin"></span>Still reading ' + escapeHtml(what)
      + ' — the public node is slow to answer.'
      + (onRetry ? ' <button class="copybtn" type="button" data-sr-retry>Retry now</button>' : '');
    host.appendChild(el);
    const b = el.querySelector('[data-sr-retry]');
    if (b && onRetry) b.onclick = () => { b.disabled = true; b.textContent = 'Retrying…'; onRetry(); };
  }, ms);
  return () => clearTimeout(t);
}

/**
 * 链表读不到时，把链选择器里那个 **"Loading…"** 换成"能照做"的状态（各页共用）。
 *
 * 为什么值得单独一个函数（2026-10-15 用户第三次反馈"表单区域仍有 Loading…"）：
 * 每个页面顶部都有一个链选择器，初值是写死的 `<button>Loading…</button>`，等 `chains()`
 * 回来才画成真的按钮。**`chains()` 失败时回的是空数组**，而各页那时只改了一句 hint 就
 * `return` —— 那个 "Loading…" 于是永远挂在那儿，用户以为页面还在加载，其实它已经放弃了。
 * （/launch 早先单独修过，其余五页漏了；这次收进共享层。）
 */
export function showChainSegFailed(seg, hint, onRetry) {
  const el = typeof seg === 'string' ? document.getElementById(seg) : seg;
  const h = typeof hint === 'string' ? document.getElementById(hint) : hint;
  if (el) {
    el.innerHTML = '<button type="button" class="on">Retry</button>';
    const b = el.querySelector('button');
    if (b) b.onclick = () => {
      el.innerHTML = '<button type="button" class="on">Loading…</button>';
      if (onRetry) onRetry();
    };
  }
  if (h) {
    h.innerHTML = '<span class="warnline">Could not load the chain list.</span> '
      + 'Nothing on this page knows which chain to talk to until it loads — retry above.';
  }
}

/** 列表页共用的空状态（图标 + 一句人话 + 去做的按钮）—— 不允许停在 "Reading…"。 */
export function emptyState({ title, body = '', actions = [] } = {}) {
  return '<div class="empty"><div class="empty-ic"><img src="/oaken/ic-oaken.svg" alt=""></div>'
    + '<b>' + escapeHtml(title || 'Nothing here yet.') + '</b>'
    + (body ? '<p class="muted">' + escapeHtml(body) + '</p>' : '')
    + (actions.length
      ? '<div class="empty-acts">' + actions.map((a) =>
          `<a class="btn ${a.primary ? 'btn-p' : 'btn-s'}" href="${a.href}">${escapeHtml(a.label)}</a>`).join('') + '</div>'
      : '')
    + '</div>';
}

export function provider(chain = CHAIN) {
  const key = Number(chain?.id ?? DEFAULT_CHAIN_ID);
  if (_providers.has(key)) return _providers.get(key);
  if (!window.ethers) throw new Error('ethers is not loaded');
  const url = bestRpc(chain);
  /**
   * ⚠ **打开 JSON-RPC 批量**（2026-10-15）。
   *
   * 起因：代币工厂那一列要读每个币的 symbol/name/totalSupply/decimals —— 8 个币就是 32 个
   * `eth_call`，默认情况下它们**各自一个 HTTP 请求**，同一瞬间打出去会被公共端点限流，
   * 表现是**整列都是 "—"**（单个调明明是对的）。批量之后它们合成少数几个请求：
   * 既快，又不触发限流。后端索引器（`src/rpc.mjs` 的 `callMany`）本来就是这么打这些端点的，
   * 所以这条路是通的。
   */
  const p = new window.ethers.JsonRpcProvider(url, chain.id, {
    staticNetwork: true,
    batchMaxCount: 10,     // 一个批次最多 10 个调用
    batchStallTime: 20,    // 攒 20ms 就发（默认 10ms 也够，这里明确写出来）
  });
  /* 300 秒 → 10 秒（治不了"连不上的主机"，但治得了"连上了却不回"的那种挂） */
  try { p._getConnection().timeout = 10_000; } catch { /* 内部接口变了就算了 */ }
  _providers.set(key, p);
  /* 第一次真的用这条链时，后台探一遍它的 RPC —— 不阻塞这次读，谁快下一轮用谁。 */
  if (!_probed.has(key)) { _probed.add(key); probeChain(chain).catch(() => { /* 探测挂了不影响读 */ }); }
  return p;
}
export function adapter(chain, signerOrProvider, version = 'v1') {
  return new window.ethers.Contract(contractSet(version).adapter, ABI, signerOrProvider || provider(chain));
}
export function erc20(chain, address, signerOrProvider) {
  /**
   * ⚠ **地址必须是地址**（2026-10-15 真链 E2E 抓到的）。
   *
   * ethers v6 拿到一个空串当**合约地址**时，会把它当 ENS 名去解析，抛的是一句
   * "an ENS name used for a contract target must be correctly configured (value="")" ——
   * 用户看到的是"锁币失败 + 一句 ENS"，而真实原因是**那一刻代币地址还是空的**
   * （`loadToken()` 会先把 state.token 清空、读完再填；在读没回来的空档里点一下就踩到）。
   * 这里直接拦成一句人话，别让 ethereum 的 ENS 解析把话说歪。
   */
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ''))) {
    throw new Error('That token address is not filled in yet — wait for it to be read, then try again.');
  }
  return new window.ethers.Contract(address, ERC20, signerOrProvider || provider(chain));
}

/* ── 钱包 ────────────────────────────────────────────────────────────────
 *
 * **不能只认 `window.ethereum`。** OKX 扩展一定注入 `window.okxwallet`，而
 * `window.ethereum` 只在"它被设成默认钱包 / 页面上没有别的钱包"时才注入 ——
 * 于是装了 OKX 的人点 Connect 收到的是「No wallet found」（2026-10-12 复现）。
 *
 * 两条发现路径：
 *   · **EIP-6963** —— 钱包自己 announce、页面按公告建列表（OKX / MetaMask / Rabby
 *     这一代都支持）。顺序要紧：**先挂监听、再发 request** —— 反了会漏掉那些
 *     只应答一次 announce 的钱包。
 *   · **老式全局** —— 不 announce 的老扩展：`window.okxwallet`、`window.ethereum`。
 *
 * 多把钱包时 `connect()` 先弹一次选择面板（选中记在 localStorage）；只有一把时
 * 行为和一个钱包的时代完全一样 —— 不多一次点击。
 */
const WALLET_LS = 'oaken.wallet';
const _wallets = new Map();       // key → { key, name, icon, provider }
const _seenProviders = new Set(); // provider 对象去重（6963 的 Provider 常就是 window.ethereum 本体）
const _seenNames = new Set();     // 名字去重：同一把钱包从两条路进来只留一条

function addWallet(provider, { key, name, icon } = {}) {
  if (!provider || typeof provider.request !== 'function') return;
  if (_seenProviders.has(provider)) return;
  const label = String(name || 'Wallet');
  if (_seenNames.has(label.toLowerCase())) return;
  _seenProviders.add(provider);
  _seenNames.add(label.toLowerCase());
  const k = String(key || label);
  _wallets.set(k, { key: k, name: label, icon: icon || '', provider });
}

window.addEventListener('eip6963:announceProvider', (e) => {
  const d = e.detail || {}, info = d.info || {};
  addWallet(d.provider, { key: info.rdns || info.uuid, name: info.name, icon: info.icon });
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

/** 老式全局扫描。模块求值时一次、之后每次要用钱包时再扫（有的扩展注入得晚）。 */
function scanLegacy() {
  const okx = window.okxwallet;
  if (okx) addWallet(okx.request ? okx : okx.ethereum, { key: 'okx', name: 'OKX Wallet' });
  /**
   * **Phantom 的 EVM provider 在 `window.phantom.ethereum`**（Phantom 文档的检测方式）。
   *
   * ⚠ 它的 `window.ethereum` 是个**兼容壳**：录制的 Phantom 26.32.0 里
   * `isMetaMask: true, isPhantom: false`，而 EIP-6963 公告的是**另一个对象**
   * （`sameAsInjected: false`）。只按旗标认，只装 Phantom 的人会在面板里看到一行
   * 根本不存在的 "MetaMask"。
   *
   * 判据：`window.ethereum` 自称 MetaMask、页面上又有 Phantom、而且**没有任何 6963
   * 公告认领这个对象** ⇒ 它是 Phantom 的兼容壳，不当成另一把钱包（否则只装 Phantom
   * 的人会看到两行）。真 MetaMask 会公告**同一个对象**（`sameAsInjected: true`），
   * 照旧按 MetaMask 列。
   */
  const ph = window.phantom && window.phantom.ethereum;
  const phOk = !!(ph && typeof ph.request === 'function');
  if (phOk) addWallet(ph, { key: 'phantom', name: 'Phantom' });
  const eth = window.ethereum;
  if (eth && typeof eth.request === 'function') {
    const phantomCompat = phOk && !!eth.isMetaMask && !eth.isPhantom && !_seenProviders.has(eth);
    if (!phantomCompat) {
      const name = eth.isOkxWallet ? 'OKX Wallet' : eth.isPhantom ? 'Phantom' : eth.isMetaMask ? 'MetaMask' : eth.isRabby ? 'Rabby' : 'Browser wallet';
      addWallet(eth, { key: eth.isOkxWallet ? 'okx' : eth.isMetaMask ? 'metamask' : 'injected', name });
    }
  }
}
scanLegacy();
setTimeout(scanLegacy, 400);

export function listWallets() { scanLegacy(); return [..._wallets.values()]; }

/**
 * 当前该用哪把 —— **不弹面板**（owner 2026-10-14：不让用户挑插件，装了哪个就用哪个）。
 *
 * 顺序：
 *   ① 用户**显式切过**的那把（localStorage）—— "Use another wallet" 选择仍然算数；
 *   ② `window.ethereum` —— 浏览器里那把默认扩展，扩展自己会弹审批窗（"自动弹跳"就是它）；
 *   ③ 只有一把被公告的（6963）；
 *   ④ 都没有 → null（connect 时如实说"没装钱包"）。
 *
 * 旧版在"多把钱包且没选过"时回 null、由 connect 弹选择面板 —— 那是逼用户先做一次
 * 技术选择，owner 明确不要。多把并存时选谁交给浏览器/扩展自己（window.ethereum 的
 * 归属由用户装扩展的顺序和"设为默认"决定，那本来就是用户的选择）。
 */
function chosenWallet() {
  const list = listWallets();
  let want = null;
  try { want = localStorage.getItem(WALLET_LS); } catch { /* 隐私模式里没有 localStorage */ }
  /**
   * WalletConnect 也是一把"钱包"，但它不是注入式的 —— 它活在我们自己建的 provider 里。
   * 上次选的是它时**就以它为准**：`_wcProvider` 还没建好（刷新后正在接会话）也要返回 null，
   * 不能让 `window.ethereum` 冒名顶替 —— 那会把"用手机连的"变成"用扩展连的"。
   */
  if (want === 'walletconnect') {
    return _wcProvider ? { key: 'walletconnect', name: 'WalletConnect', icon: '', provider: _wcProvider } : null;
  }
  if (want && _wallets.has(want)) return _wallets.get(want);
  const eth = window.ethereum;
  if (eth && typeof eth.request === 'function') {
    const hit = list.find((w) => w.provider === eth);
    if (hit) return hit;
    return { key: 'injected', name: 'Browser wallet', provider: eth };
  }
  return list[0] || null;
}

/** 用户主动断开过？断开之后刷新页面不该自己连回来（见 wallet.disconnect）。 */
const walletOff = () => { try { return localStorage.getItem(WALLET_LS + '.off') === '1'; } catch { return false; } };
const setWalletOff = (on) => { try { on ? localStorage.setItem(WALLET_LS + '.off', '1') : localStorage.removeItem(WALLET_LS + '.off'); } catch { /* 隐私模式 */ } };

/** EIP-1193 的错误翻成人话（4001 / -32002 这两个每个 dapp 都会遇到）。 */
export function humanizeWalletError(e) {
  const code = e && (e.code ?? (e.info && e.info.error && e.info.error.code));
  const msg = String((e && (e.shortMessage || e.message)) || e || '');
  /* 我们自己写过的那句"下一步怎么做"（见 chainRefusedError）别再翻一遍 —— 翻掉就没了 */
  if (e && e.friendly) return msg;
  if (code === 4001 || /user rejected|user denied|rejected the request/i.test(msg)) return 'Request rejected in your wallet.';
  if (code === -32002 || /already pending|already has a pending/i.test(msg)) return 'Your wallet already has a pending request — open the extension and approve or dismiss it.';
  if (code === 4902 || /Unrecognized chain/i.test(msg)) return 'That chain is not in your wallet yet.';
  if (code === 4901 || /not connected to the requested chain/i.test(msg)) return 'Your wallet would not switch networks. Switch to the network this page uses in your wallet, then try again.';
  if (/no wallet/i.test(msg)) return msg;
  return msg || 'The wallet did not complete the request.';
}

/**
 * 失败的是不是"钱包不肯挪到这条链上"（而不是用户拒绝/断网）。
 *
 * 为什么要单独判：Phantom **不允许 dapp 加网络**（录制档案：wallet_addEthereumChain
 * 一律回 4901 "The Provider is not connected to the requested chain."），而且只有用户在
 * Settings → Active Networks 里打开过 Robinhood Chain，切链才会成功。这类失败以前会
 * 把整次连接判死，用户只看到 Phantom 的日志口吻原话。
 */
function chainRefused(e) {
  const code = e && (e.code ?? (e.info && e.info.error && e.info.error.code));
  const msg = String((e && (e.shortMessage || e.message)) || '');
  return code === 4901 || code === 4902 || code === -32603
    || /not connected to the requested chain|Unrecognized chain|unsupported chain/i.test(msg);
}

/** 把"钱包不肯切链"写成用户能照着做的一步（Phantom 要用户自己在 Active Networks 里打开）。 */
function chainRefusedError(want, e) {
  const w = chosenWallet();
  const p = w && w.provider;
  const phantom = !!(w && /phantom/i.test(w.name || ''))
    || !!(p && p.isPhantom)
    || !!(window.phantom && p && p === window.phantom.ethereum);
  const declined = !!(e && (e.code === 4001 || /user rejected|user denied|rejected the request/i.test(String(e.message || ''))));
  const err = new Error(declined
    ? `You declined the switch to ${want.name}. You are connected — switch networks in your wallet (or click the network chip) before sending a transaction.`
    : phantom
      ? `Phantom will not switch networks for this site. Open Phantom → Settings → Active Networks, turn on ${want.name} (update Phantom if it is not listed), then reload this page and connect again.`
      : `Your wallet did not switch to ${want.name}. Switch to ${want.name} in your wallet, then try again.`);
  err.code = (e && e.code) || 4901;
  err.friendly = true;      // humanizeWalletError 原样放行
  err.chainRefused = true;  // activate() 据此"连接照连，只是链没对上"
  return err;
}

/* ── 连接面板：WalletConnect + 已装/未装的钱包 ────────────────────────────
 *
 * 2026-10-16 照 PinkSale 那套成熟的钱包层补的（研究记录在记忆 `pinksale-wallet-stack`）。
 * 三条照抄、三条有意不照抄：
 *   · 照抄**面板的形状**：WalletConnect 一行（带 QR CODE 标）+ 本机已装的钱包（Installed 标）
 *     + 没装的钱包给官网/商店链接 —— 第一次来的人一眼知道装什么、去哪装；
 *   · 照抄**按需加载**：WalletConnect 那半边（509 KB，官方 ethereum-provider + qr-creator）
 *     只在真的点它时才下（PinkSale 是 12 MB 常驻，这条不学）；
 *   · 照抄**没配上就不摆控件**：projectId 空着，整行不出现，而不是点开再报错；
 *   · **不照抄**"一进来就弹层摆一堆钱包让人挑"—— owner 2026-10-14 定过"装了哪个就用哪个"，
 *     所以这一层只在**一把都没装**时才由 connect() 拉起来；
 *   · **不照抄**热链别人的图床：图标是 8 张本地 webp（0.4–2 KB），
 *     名称/官网/商店链接取自 Reown 钱包注册表 2026-10-16 的那一次快照。
 *
 * 每一行只有两种归宿：**装了的直接连**（不再二次确认）、**没装的开官网**。
 * 关掉面板 = 什么都没发生，调用方按"没有钱包"处理（页面照原样 toast）。
 */
const WALLET_CATALOG = [
  { key: 'metamask', name: 'MetaMask', icon: '/app/img/wallet-metamask.webp', web: 'https://metamask.io/download/',
    chrome: 'https://chrome.google.com/webstore/detail/metamask/nkbihfbeogaeaoehlefnkodbefgpgknn', app: 'https://apps.apple.com/us/app/metamask/id1438144202' },
  { key: 'okx', name: 'OKX Wallet', icon: '/app/img/wallet-okx.webp', web: 'https://www.okx.com/web3',
    chrome: 'https://chrome.google.com/webstore/detail/okx-wallet/mcohilncbfahbmgdjkbpemcciiolgcge', app: 'https://apps.apple.com/us/app/okx-buy-bitcoin-eth-crypto/id1327268470' },
  { key: 'rabby', name: 'Rabby', icon: '/app/img/wallet-rabby.webp', web: 'https://rabby.io/',
    chrome: 'https://chrome.google.com/webstore/detail/rabby-wallet/acmacodkjbdgmoleebolmdjonilkdbch', app: 'https://apps.apple.com/us/app/rabby-wallet-crypto-evm/id6474381673' },
  { key: 'trust', name: 'Trust Wallet', icon: '/app/img/wallet-trust.webp', web: 'https://trustwallet.com/',
    chrome: 'https://chrome.google.com/webstore/detail/trust-wallet/egjidjbpglichdcondbcbdnbeeppgdph', app: 'https://apps.apple.com/app/apple-store/id1288339409' },
  { key: 'binance', name: 'Binance Wallet', icon: '/app/img/wallet-binance.webp', web: 'https://www.binance.com/en/web3wallet',
    chrome: 'https://chromewebstore.google.com/detail/binance-wallet/cadiboklkpojfamcoggejbbdjcoiljjk', app: 'https://www.binance.com/en/download' },
  { key: 'bitget', name: 'Bitget Wallet', icon: '/app/img/wallet-bitget.webp', web: 'https://web3.bitget.com',
    chrome: 'https://chrome.google.com/webstore/detail/bitkeep-crypto-nft-wallet/jiidiaalihmmhddjgbnbgdfflelocpak', app: 'https://web3.bitget.com/en/wallet-download?type=0' },
  { key: 'coinbase', name: 'Coinbase Wallet', icon: '/app/img/wallet-coinbase.webp', web: 'https://base.app',
    chrome: 'https://chrome.google.com/webstore/detail/coinbase-wallet-extension/hnfanknocfeofbddgcijnmhnfnkdnaad', app: 'https://apps.apple.com/app/apple-store/id1278383455' },
  { key: 'robinhood', name: 'Robinhood Wallet', icon: '/app/img/wallet-robinhood.webp', web: 'https://robinhood.com/web3-wallet/',
    chrome: 'https://robinhood.com/web3-wallet/', app: 'https://robinhood.com/web3-wallet/' },
];

/**
 * WalletConnect 的 projectId（cloud.reown.com 免费建一个项目就有）。
 *
 * **空着 = 整行不出现** —— 这一条是有意的：没配置就先别摆一个点了没反应的控件
 * （[[guard-that-never-matches-is-green]] 那一族的反面教材就是"看起来在工作"）。
 * 填上之后：连接面板里出现 WalletConnect 一行，手机扫码/桌面出码全通。
 */
const WC_PROJECT_ID = '2c42b8c989f0008d8598ef23794b2168';
const WC_CHUNK = '/app/vendor/oaken-walletconnect.js';   // rebrand 会给它加 ?v=<内容哈希>
let _wcModule = null, _wcProvider = null, _wcLoading = null;

/** 用户上次选的是钱包吗？—— 决定刷新页面时要不要把 WalletConnect 会话接回来。 */
const wcSelected = () => { try { return localStorage.getItem(WALLET_LS) === 'walletconnect'; } catch { return false; } };

/**
 * 建（或复用）WalletConnect provider —— `import()` 只跑一次。
 *
 * ⚠ 三条来之不易的取舍：
 *   · `chains` 只放**一条**（当前这条），其余进 `optionalChains` —— required namespace
 *     里放多条时，钱包只要不支持其中一条就**整单配对失败**（Robinhood Chain 这样的
 *     小众链尤其容易踩），而 optional 是"支持就给你"。
 *   · `showQrModal: false` —— 官方包里那个弹层是 Reown AppKit（1.6 MB），我们不装它；
 *     bundle 里只留了它的**动态 import**（走不到那条路），QR 由 qr-creator 自己画。
 *   · rpcMap 用我们自己的 RPC —— 钱包侧的读走我们的节点，不额外依赖别人的网关。
 */
async function wcLoad() {
  if (_wcProvider) return _wcProvider;
  if (_wcLoading) return _wcLoading;
  _wcLoading = (async () => {
    const mod = _wcModule || (_wcModule = await import(WC_CHUNK));
    const live = await chains();
    const list = live.length ? live : [CHAIN];
    const active = await currentChain();
    const ids = list.map((c) => c.id);
    const first = ids.includes(active.id) ? active.id : ids[0];
    const p = await mod.EthereumProvider.init({
      projectId: WC_PROJECT_ID,
      chains: [first],
      optionalChains: ids.filter((i) => i !== first),
      rpcMap: Object.fromEntries(list.map((c) => [c.id, c.rpc])),
      showQrModal: false,
      metadata: {
        name: 'OAKEN',
        description: 'Token and LP locks on Robinhood Chain.',
        url: 'https://oaken.one',
        icons: ['https://oaken.one/logo192.png'],
      },
    });
    _wcProvider = p;
    bindProvider(p);
    /* 手机那头把会话删了（session_delete）→ 本地也得回到未连接，别装作还连着 */
    p.on('session_delete', () => {
      try { localStorage.removeItem(WALLET_LS); } catch { /* 隐私模式 */ }
      _subs.accounts.forEach((f) => f(null));
    });
    return p;
  })().finally(() => { _wcLoading = null; });
  return _wcLoading;
}

/**
 * 连接面板。**只在"要签名但一把注入式钱包都没有"时由 connect() 拉起来** ——
 * 用户主动点了连接却无路可走，该看到"装什么、去哪装"，而不是一条 toast。
 *
 * 返回：`{ kind:'injected', wallet }` | `{ kind:'wc', address }` | `null`（关掉了）
 */
function walletPanel() {
  return new Promise((resolve) => {
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    const installed = listWallets();
    const have = new Set(installed.map((w) => w.name.toLowerCase()));
    const rest = WALLET_CATALOG.filter((c) => !have.has(c.name.toLowerCase()));
    const el = document.createElement('div');
    el.id = 'wallet-panel';
    el.className = 'wp-overlay';
    const inst = (w) => `<button type="button" class="wp-row" data-inst="${escapeHtml(w.key)}">
        ${w.icon ? `<img src="${escapeHtml(w.icon)}" width="26" height="26" alt="">` : '<span class="wdot"></span>'}
        <b>${escapeHtml(w.name)}</b><em class="wp-tag ok">Installed</em></button>`;
    const cat = (c) => `<a class="wp-row" href="${escapeHtml(mobile ? c.app : c.chrome)}" target="_blank" rel="noopener">
        <img src="${escapeHtml(c.icon)}" width="26" height="26" alt="">
        <b>${escapeHtml(c.name)}</b><em class="wp-tag get">Get ↗</em></a>`;
    el.innerHTML = `<div class="wp" role="dialog" aria-label="Connect a wallet">
      <div class="wp-head"><b>Connect a wallet</b>
        <button type="button" class="wp-x" aria-label="Close">${icon('x', 16)}</button></div>
      <div class="wp-body">
        ${WC_PROJECT_ID ? `<button type="button" class="wp-row wp-wc" data-act="wc">
            ${icon('qr', 26)}<b>WalletConnect</b><em class="wp-tag tag-gold">QR CODE</em></button>` : ''}
        ${installed.length ? `<div class="wp-sec">Installed in this browser</div>${installed.map(inst).join('')}` : ''}
        <div class="wp-sec">${installed.length ? 'Other wallets' : 'Get a wallet'}</div>
        ${rest.map(cat).join('')}
        ${mobile ? `<div class="wp-note">On a phone the simplest route is your wallet app's own browser —
          MetaMask → Browser, Trust/OKX → DApp browser. Open <b>oaken.one</b> there.</div>` : ''}
      </div>
      <div class="wp-foot">OAKEN only ever asks for an address and a signature. Never a seed phrase.</div>
    </div>`;
    document.body.appendChild(el);
    /**
     * **钉在"眼睛看到的那个矩形"上**，不是布局视口。
     *
     * 手机上我们的布局视口是 999px（顶栏那排导航比 390 宽，Chrome 的 shrink-to-fit 会把
     * 布局视口撑开），而 `position: fixed` 的 inset:0 是相对**布局视口**的 —— 于是居中算在
     * 999 的中点，卡片落在 x≈290..710，而手机屏幕上只有 0..390：**一半在屏外**。
     * （2026-10-16 量出来的：`visualViewport` 390×844、卡片 290..710、inView=false。）
     * `visualViewport` 给的就是那个矩形，跟着它走 + 缩放/滚动时重算，桌面上两者相等、无副作用。
     */
    const vv = window.visualViewport;
    const fit = () => {
      if (!vv) return;
      el.style.left = vv.offsetLeft + 'px';
      el.style.top = vv.offsetTop + 'px';
      el.style.width = vv.width + 'px';
      el.style.height = vv.height + 'px';
    };
    fit();
    if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (vv) { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); }
      el.remove(); document.removeEventListener('keydown', onKey); resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);
    el.querySelector('.wp-x').onclick = () => finish(null);
    el.onclick = (e) => { if (e.target === el) finish(null); };
    for (const b of el.querySelectorAll('[data-inst]')) {
      b.onclick = () => finish({ kind: 'injected', wallet: installed.find((w) => w.key === b.dataset.inst) || null });
    }
    const wcBtn = el.querySelector('[data-act="wc"]');
    if (wcBtn) wcBtn.onclick = () => wcPanel(el, finish);

    /**
     * **下一个弹窗先说清楚**（2026-10-16）。
     *
     * 连上之后我们会 `ensureChain` —— 钱包不在我们这条链上时会再弹一次"加网络/切网络"。
     * 两个弹窗挨着弹、中间没有任何解释，就是 owner 说的"不连贯"。这里在面板里先说一句，
     * 第二个弹窗就从"意外"变成"意料之中"。
     * 读不到链（没授权且钱包不答 `eth_chainId`）就什么都不写 —— 不编。
     */
    (async () => {
      try {
        const wk = await wallet.chainId();
        const live = await chains();
        if (!wk || !live.length || live.some((c) => c.id === wk)) return;
        const body = el.querySelector('.wp-body');
        if (!body || done) return;
        const note = document.createElement('div');
        note.className = 'wp-note';
        /**
         * Phantom 不会替站点加网络：它只认用户在 Settings → Active Networks 里
         * 打开过的链（录制档案：wallet_addEthereumChain 一律 4901）。在这里先说一句，
         * 比连完之后再报错强。
         */
        const phantom = installed.some((w) => /phantom/i.test(w.name || ''));
        note.textContent = `Your wallet is on network ${wk}. OAKEN runs on ${CHAIN.name} — connecting will ask it to switch.`
          + (phantom ? ` Phantom only offers ${CHAIN.name} after you turn it on: Settings → Active Networks.` : '');
        const secs = body.querySelectorAll('.wp-sec');
        const anchor = secs[secs.length - 1];
        body.insertBefore(note, anchor || null);
      } catch { /* 读不到链就算了 —— 宁可少一句，也不编一句 */ }
    })();

    /**
     * 面板**关不掉**到"配对完成或失败"为止是不够友好的 —— 但 QR 已经画在那儿了，
     * 用户扫完码手机那头要确认，这一小段时间里把面板收掉等于让他重来。
     * 所以：配对一启动就置 `busy`，X / 点背景都不再关闭，只有取消按钮能中止。
     */
  });
}

/** 面板里的 WalletConnect 视图：画 QR、等手机批准。 */
async function wcPanel(host, finish) {
  const body = host.querySelector('.wp-body');
  body.innerHTML = `<div class="wp-qr">
      <div class="wp-qrbox"><div class="wp-wait"><span class="spin"></span>Loading the connector…</div></div>
      <div class="wp-hint" id="wp-status">This is a 509 KB add-on — it loads only when you use WalletConnect.</div>
      <button type="button" class="btn btn-g" data-act="cancel">Cancel</button>
    </div>`;
  const say = (s) => { const x = host.querySelector('#wp-status'); if (x) x.textContent = s; };
  let p = null;
  const cancel = () => { try { p && p.signer && p.signer.abortPairingAttempt && p.signer.abortPairingAttempt(); } catch { /* 没有就算了 */ } finish(null); };
  host.querySelector('[data-act="cancel"]').onclick = cancel;
  /* 配对已经启动了：右上角的 X 和点背景都改成**取消配对**（而不是"悄悄关掉、手机那头还挂着"） */
  host.querySelector('.wp-x').onclick = cancel;
  host.onclick = (e) => { if (e.target === host) cancel(); };
  try {
    p = await wcLoad();
  } catch (e) {
    body.querySelector('.wp-qrbox').innerHTML = `<div class="wp-err">${escapeHtml(humanizeWalletError(e))}</div>`;
    say('Could not load the WalletConnect connector.');
    return;
  }
  const head = host.querySelector('.wp-qrbox');
  if (p.session) { finish({ kind: 'wc', address: (p.accounts || [])[0] || null }); return; }
  let uri = null;
  try {
    const connecting = p.connect();
    connecting.catch(() => { /* 下面按各自的路径收场；这里只防 unhandled rejection */ });
    uri = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The WalletConnect relay did not answer — it may be unreachable from this network.')), 20000);
      p.once('display_uri', (u) => { clearTimeout(t); resolve(u); });
      connecting.catch((e) => { clearTimeout(t); reject(e); });
    });
    /* QR **必须深色点阵画在浅底上** —— 我们的面板是暗色的，直接反色画上去扫不出来 */
    const qr = await wcQR(uri);
    if (qr) { head.innerHTML = ''; qr(head); } else head.innerHTML = '<div class="wp-wait">Scan with your phone\'s wallet app</div>';
    say('Scan with your phone\'s wallet app');
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button'; copyBtn.className = 'btn btn-g'; copyBtn.textContent = 'Copy pairing link';
    copyBtn.onclick = async () => { const ok = await copy(uri); copyBtn.textContent = ok ? 'Copied ✓' : 'Copy failed'; };
    host.querySelector('.wp-qr').insertBefore(copyBtn, host.querySelector('[data-act="cancel"]'));
    await connecting;
    const addr = (p.accounts || [])[0] || null;
    try { localStorage.setItem(WALLET_LS, 'walletconnect'); } catch { /* 隐私模式 */ }
    setWalletOff(false);
    if (addr) _subs.accounts.forEach((f) => f(addr));
    finish({ kind: 'wc', address: addr });
  } catch (e) {
    const msg = humanizeWalletError(e);
    head.innerHTML = `<div class="wp-err">${escapeHtml(msg)}</div>`;
    say('Pairing did not go through.');
  }
}

/** 把 `wc:` URI 画成 QR（qr-creator 在同一个 bundle 里，跟 provider 一起下）。 */
async function wcQR(text) {
  try {
    const mod = _wcModule || (_wcModule = await import(WC_CHUNK));
    if (!mod.QrCreator) return null;
    return (el) => mod.QrCreator.render({ text, radius: 0.32, ecLevel: 'M', fill: '#191410', background: '#f7f2e8', size: 216 }, el);
  } catch { return null; }
}

/**
 * 刷新页面时把 WalletConnect 会话接回来。
 *
 * 只在**上次选的是它**时才跑（别的访客不为这 509 KB 付费）。接不回来就悄悄把记号清掉 ——
 * 用户看到的是"未连接 + 点 Connect 有面板"，而不是一个假装的连接状态。
 */
async function wcRestore() {
  if (!WC_PROJECT_ID || !wcSelected() || walletOff()) return;
  try {
    const p = await wcLoad();
    if (!p.session) { try { localStorage.removeItem(WALLET_LS); } catch { /* 隐私模式 */ } return; }
    const addr = (p.accounts || [])[0] || null;
    if (addr) _subs.accounts.forEach((f) => f(addr));
  } catch { /* 加载失败就当没连过，不打扰用户 */ }
}

/**
 * 钱包选择面板。**只在多于一把时出现**；返回选中的那把，点别处/没得选回 null。
 * 复用 `.chain-menu` 的样式（同一个视觉语言，少一套 CSS）。
 */
function pickWallet() {
  const list = listWallets();
  if (list.length <= 1) return Promise.resolve(list[0] || null);
  return new Promise((resolve) => {
    document.getElementById('wallet-menu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'wallet-menu';
    menu.className = 'chain-menu wallet-menu';
    menu.innerHTML = list.map((w) => `<button type="button" data-key="${w.key}">
        ${w.icon ? `<img src="${w.icon}" width="20" height="20" alt="">` : '<span class="wdot"></span>'}
        <b>${w.name}</b><span class="muted">Installed</span></button>`).join('')
      + '<div class="hint" style="padding:10px 12px 6px">Both are real wallets in this browser — pick the one you want to use. OAKEN only asks for an address and a signature, never a seed phrase.</div>';
    document.body.appendChild(menu);
    const anchor = document.getElementById('connect') || document.getElementById('gate-connect');
    const r = anchor?.getBoundingClientRect();
    if (r) { menu.style.top = `${r.bottom + 8}px`; menu.style.right = `${Math.max(12, window.innerWidth - r.right)}px`; }
    else { menu.style.top = '84px'; menu.style.right = '24px'; }
    const done = (w) => { menu.remove(); document.removeEventListener('click', off); resolve(w); };
    const off = (ev) => { if (!menu.contains(ev.target)) done(null); };
    for (const b of menu.querySelectorAll('button[data-key]')) {
      b.onclick = () => {
        const w = list.find((x) => x.key === b.dataset.key) || null;
        if (w) { try { localStorage.setItem(WALLET_LS, w.key); } catch { /* 同上 */ } }
        done(w);
      };
    }
    setTimeout(() => document.addEventListener('click', off), 0);
  });
}

/* 事件扇出：页面只订阅一次，钱包换了也不用重挂。
   `phase` 是"正在请钱包签名"这一段 —— 顶栏那个按钮靠它写 "Check your wallet…"：
   现在点 Connect 先出面板，面板还开着的时候**不能**写那句话（钱包那边什么都没发生）。 */
const _subs = { accounts: [], chain: [], phase: [] };

/**
 * 页面注册的"钱包换链了，我自己重画"（2026-10-16）。
 *
 * 背景：以前钱包一换到我们认的另一条链就 `location.reload()` —— 数据是对的，但那一下白闪
 * 正是 owner 说的"不连贯"。现在页面可以**自己**重画（它最清楚哪些东西跟着链走），
 * 顶栏只负责广播。
 *
 * ⚠ **没注册的页面照旧整页重载** —— 这是有意的保守：宁可闪一下，也不能让页面继续显示
 * 上一条链的数据（那比闪一下危险得多）。所以这个机制是"逐页接管"，不是一刀切。
 */
const _chainSwitch = [];
export function onChainSwitch(fn) { if (typeof fn === 'function') _chainSwitch.push(fn); }
/** 这一页有没有自己接管换链（顶栏那份链清单用它决定还要不要重载）。 */
export const handlesChainSwitch = () => _chainSwitch.length > 0;

/**
 * gas 那一格重画（模块级 —— 顶栏和换链流程都要用）。
 * 读不到就写 `—`（**不编 0**）；钱包不在我们这条链上时**整格收起来**：那个数是从我们的链
 * 读的，摆着就是误导（见 `_wrongNet`）。
 */
async function paintGas(addr) {
  const chip = document.getElementById('gas-chip');
  if (!chip) return;
  chip.dataset.addr = addr || '';
  if (!addr || _wrongNet) { chip.style.display = 'none'; chip.textContent = ''; return; }
  chip.style.display = '';
  chip.innerHTML = '<span class="muted">gas</span><span class="g">—</span>';
  try {
    const c = await currentChain();
    const bal = await nativeBalance(c, addr);
    chip.innerHTML = '<span class="muted">gas</span><span class="g">'
      + (bal === null ? '—' : fmtAmount(bal, 18, 5) + ' ' + (c.native || 'ETH')) + '</span>';
    chip.title = 'Gas balance on ' + c.name;
  } catch { chip.innerHTML = '<span class="muted">gas</span><span class="g">—</span>'; }
}

/**
 * 链换了（钱包自己换的、或用户在顶栏链清单里选的）—— 全套重画都走这里。
 *
 * 顺序要紧：先更新"这套 UI 是按哪条链渲染的"，再画顶栏，最后才让页面重画 ——
 * 页面重画时会 `await currentChain()`，那必须已经拿到新链。
 * 页面没接管（`_chainSwitch` 空）→ 退回整页重载。
 */
function applyChainChange(id) {
  _shownChainId = id;
  setSiteChain(id);              // 记住这条链：断开钱包之后站点仍然停在这儿
  wireChain();
  paintGas(document.getElementById('connect')?.dataset.addr || '');
  if (!_chainSwitch.length) { location.reload(); return; }
  for (const f of _chainSwitch) {
    try { f(id); } catch { /* 页面自己的重画出错不能带崩顶栏 —— 它自己会 toast */ }
  }
}
/**
 * **页面这套 UI 现在是按哪条链渲染的**（wireChain 每次跑都记一笔）。
 *
 * ⚠ 判"要不要重载"不能拿 `currentChain()` 现算 —— 它跟着钱包跑，钱包一换链它就同一步跟过去，
 * `id !== active.id` 永远为假，重载分支是**死代码**（真钱包上从没触发过；测试里一个
 * "链ID 没跟着事件更新"的假钱包才让它现形）。拿"当前 UI 的那条链"比才对：
 *   换了链 + 新链我们部署过 + 和当前 UI 的不是同一条 → 页面重来（表单/余额/代币都是按老链的）；
 *   换到我们没部署的链 → 不重载，顶栏如实说 Wrong network。
 */
let _shownChainId = null;
const _bound = new WeakSet();
function bindProvider(p) {
  if (!p || typeof p.on !== 'function' || _bound.has(p)) return;
  _bound.add(p);
  p.on('accountsChanged', (accs) => _subs.accounts.forEach((f) => f(accs && accs[0])));
  p.on('chainChanged', (hex) => _subs.chain.forEach((f) => f(hex)));
}
export function onWallet(evt, fn) {
  _subs[evt].push(fn);
  bindProvider(wallet.provider);
}

/**
 * 选定一把钱包并连上：记选择 → 要账户 → 挂监听 → 对齐链 → 广播。
 *
 * **记选择必须在 `ensureChain` 之前** —— `ensureChain` 用的是"当前 provider"，
 * 而那个是从 localStorage 读的。
 */
async function activate(w, chain = null) {
  /* 「正在请钱包」这一段告诉顶栏 —— 面板关掉之后、钱包批准之前，那颗按钮该写
     "Check your wallet…"（面板还开着时不写：那时钱包那边什么都没发生）。 */
  _subs.phase.forEach((f) => f(true));
  let accounts;
  try {
    accounts = await w.provider.request({ method: 'eth_requestAccounts' });
  } finally {
    _subs.phase.forEach((f) => f(false));
  }
  bindProvider(w.provider);
  try { localStorage.setItem(WALLET_LS, w.key); } catch { /* 隐私模式 */ }
  setWalletOff(false);                       // 用户明确连了一次 —— 断开记号作废
  /**
   * 切链失败**不等于连接失败**（2026-10-24 Phantom）：
   * Phantom 不允许 dapp 加网络，用户没在 Settings → Active Networks 里打开过
   * Robinhood Chain 时会回 4901。以前这里直接抛，整次连接被判死 —— 用户看到的是
   * 一句钱包日志口吻的原话，按钮退回 Connect。现在：连接照连，把"钱包还停在哪条链"
   * 如实说清楚（顶栏胶囊会变成 Switch to …）；写入路径各自都会先 ensureChain，
   * 所以在错链上仍然发不出交易。
   * 其它错误（用户拒绝授权、断网…）照旧抛。
   */
  let chainErr = null;
  try { await wallet.ensureChain(chain); }
  catch (e) {
    if (!e || !e.chainRefused) throw e;
    chainErr = e;
  }
  /**
   * 连上之后**自己广播一次**。不广播的话：从「门」按钮（/me）或工具页连上的时候，
   * 顶栏那个按钮还停在 Connect —— 真钱包此时会补发 accountsChanged，而
   * 「补发」不是标准要求的，有的钱包不发（面板选的 OKX 这一路就没人发）。
   */
  _subs.accounts.forEach((f) => f(accounts && accounts[0]));
  if (chainErr) {
    /* 顶栏的自动请切（wireChain 里"一次会话问一次"）已经没必要再问一遍 —— 这里已经说清了 */
    try { sessionStorage.setItem('oaken.chainasked', '1'); } catch { /* 隐私模式 */ }
    toast(chainErr.message, 'bad', { ms: 14000 });
  }
  return accounts[0];
}

/**
 * 已连接时顶栏按钮弹的小菜单：复制地址 / 在区块浏览器里看 / 换一把钱包（多把时）/ **断开**。
 *
 * 「断开」在标准里不存在（EIP-1193 没有 disconnect）—— MetaMask 认
 * `wallet_revokePermissions`；不认的钱包我们把**本地态**清掉，并记一个"用户主动断开"的
 * 记号，刷新时不自动连回去（见 walletOff）。所见即所得，不能点一下"断开"、刷新又回来。
 */
function walletMenu(anchor) {
  document.getElementById('wallet-menu')?.remove();
  const list = listWallets();
  const active = chosenWallet();
  const menu = document.createElement('div');
  menu.id = 'wallet-menu';
  menu.className = 'chain-menu wallet-menu';
  menu.innerHTML =
    `<div class="wbal" id="wbal"><span class="muted">Reading balance…</span></div>`
    + `<button type="button" data-act="copy"><span class="wdot"></span><b>Copy address</b><span class="muted">${active ? active.name : ''}</span></button>`
    + `<button type="button" data-act="explorer"><span class="wdot"></span><b>View on explorer</b><span class="muted"></span></button>`
    + (list.length > 1 ? `<button type="button" data-act="switch"><span class="wdot"></span><b>Use another wallet</b><span class="muted">${list.length} found</span></button>` : '')
    + `<button type="button" data-act="off"><span class="wdot"></span><b>Disconnect</b><span class="muted">this site only</span></button>`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 8}px`;
  menu.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
  /* 浏览器那一行：链上没有 explorer（本地链）时置灰，不装作有 */
  (async () => {
    const c = await currentChain();
    const btn = menu.querySelector('[data-act="explorer"]');
    const href = explorerHref(`/address/${anchor.dataset.addr}`, c);
    if (!href) { btn.disabled = true; btn.style.opacity = '.5'; btn.querySelector('.muted').textContent = 'no explorer on this chain'; return; }
    btn.querySelector('.muted').textContent = c.name;
    btn.onclick = () => { window.open(href, '_blank', 'noopener'); menu.remove(); };
  })();
  (async () => {
    try {
      const c = await currentChain();
      const bal = await wallet.provider.request({ method: 'eth_getBalance', params: [anchor.dataset.addr, 'latest'] });
      const eth = window.ethers.formatEther(bal);
      document.getElementById('wbal').innerHTML =
        `<b>${Number(eth).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${c.native || 'ETH'}</b>`
        + ` <span class="muted">· ${c.name}</span>`;
    } catch {
      const el = document.getElementById('wbal');
      if (el) el.innerHTML = '<span class="muted">Balance unavailable — RPC did not answer.</span>';
    }
  })();
  menu.querySelector('[data-act="copy"]').onclick = async () => {
    const ok = await copy(anchor.dataset.addr);
    toast(ok ? 'Address copied' : 'Clipboard blocked — the address is ' + short(anchor.dataset.addr), ok ? 'ok' : 'bad');
    menu.remove();
  };
  const sw = menu.querySelector('[data-act="switch"]');
  if (sw) sw.onclick = async () => {
    menu.remove();
    try {
      const w = await pickWallet();
      if (!w) return;
      const addr = await activate(w);
      toast(`Now using ${w.name}${addr ? ' · ' + short(addr) : ''}`);
    } catch (e) { toast(humanizeWalletError(e), 'bad'); }
  };
  menu.querySelector('[data-act="off"]').onclick = async () => {
    menu.remove();
    try { await wallet.disconnect(); toast('Disconnected'); }
    catch (e) { toast(humanizeWalletError(e), 'bad'); }
  };
  setTimeout(() => document.addEventListener('click', function off(ev) {
    if (!menu.contains(ev.target) && ev.target !== anchor) { menu.remove(); document.removeEventListener('click', off); }
  }), 0);
}

export const wallet = {
  /** 发现到的钱包（面板/测试用）。 */
  wallets: listWallets,
  /** 当前生效的 provider —— 多把未选时是 null，由 connect() 弹面板定。 */
  get provider() { return chosenWallet()?.provider || null; },
  /** 旧名字（页面里还有读它的地方），语义就是"当前 provider"。 */
  get ethereum() { return wallet.provider; },
  available() { return listWallets().length > 0; },
  /** 已连接时点顶栏按钮走这里：一个小面板（复制 / 浏览器 / 换一把 / 断开）。 */
  menu: walletMenu,
  /**
   * 连上钱包 —— **不弹选择面板**：装了哪个扩展就直接请它弹审批窗。
   * 没有钱包时抛一句人话，页面照原样把错误 toast 出去。
   */
  async connect(chain = null) {
    /**
     * **已经连着就直接返回，不再弹面板**（2026-10-17 全站自检）。
     *
     * 页面里二十来处动作（领取、撤销、买入、释放仓位…）写的是无条件的 `await wallet.connect()`。
     * 自从面板改成"点 Connect 一律先出面板"之后，这些动作在**已连接**时也会再弹一次选择面板：
     * 用户点了 Claim，却先被要求再选/再确认一次钱包，看起来像按钮没反应。
     * `walletOff()` 为真（用户主动断开）时不走这条捷径 —— 断开就是断开，动作要重新连。
     */
    if (!walletOff()) {
      const [connected] = await wallet.accounts();
      if (connected) return connected;
    }
    /**
     * **点 Connect 一律先出面板**。
     *
     * 2026-10-16 owner 反馈改的：上一条规矩是"装了扩展就一点直连、不弹面板"（2026-10-14 定的），
     * 结果**装了币安钱包的人根本看不到这块面板** —— WalletConnect 的扫码、OKX 那几行的入口
     * 全藏在里面，等于没有。现在面板永远先出来：**装了的钱包排在 WalletConnect 那一行之下**
     * （常见路径只多一次点击），换来的是所有入口都在明面上。关掉面板返回 `null`
     * （不是错误 —— 页面照原样画未连接态，调用点都不接返回值，见下面那二十来处 `await wallet.connect()`）。
     */
    const picked = await walletPanel();
    if (!picked) return null;
    if (picked.kind === 'wc') {
      if (!picked.address) return null;
      try { await wallet.ensureChain(chain); } catch { /* 切链失败不拦连接本身 */ }
      return picked.address;
    }
    const w = picked.wallet || chosenWallet();
    if (!w) {
      /* 手机上没有注入式扩展 —— 钱包 App 自带浏览器是唯一可行的路，如实教一遍 */
      const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
      throw new Error(mobile
        ? "No wallet detected in this browser. On a phone, open oaken.one inside your wallet app's own browser — MetaMask → Browser, or Trust/OKX → DApp browser."
        : 'No wallet extension found in this browser — install MetaMask, OKX or any EIP-1193 wallet, then reload.');
    }
    /* 错误在这里就翻成人话 —— 十几个调用点各写各的 `String(e.message)`，
       4001 会原样端给用户（"User rejected the request."是钱包的日志口吻，不是文案）。 */
    try { return await activate(w, chain); }
    catch (e) { throw new Error(humanizeWalletError(e)); }
  },
  /**
   * 断开。标准里没有这个方法，所以是"能做到多少做多少"：
   *   · 认 `wallet_revokePermissions` 的（MetaMask）→ 真的撤销本页权限；
   *   · 不认的 → 至少把本地态清掉，并记下"用户主动断开"，刷新不自动连回来。
   */
  async disconnect() {
    const p = wallet.provider;
    if (p && p.isWalletConnect) {
      /* WalletConnect 有**真的**断开：结束的是手机那头那条会话（不只是清本地态） */
      try { await p.disconnect(); } catch { /* 会话已经不在了就算了 */ }
      _wcProvider = null;
    } else if (p) {
      try { await p.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); } catch { /* 不认就算了 */ }
    }
    try { localStorage.removeItem(WALLET_LS); } catch { /* 隐私模式 */ }
    setWalletOff(true);
    _subs.accounts.forEach((f) => f(null));
  },
  async accounts() {
    const p = wallet.provider;
    if (!p) return [];
    try { return await p.request({ method: 'eth_accounts' }); } catch { return []; }
  },
  async chainId() {
    const p = wallet.provider;
    if (!p) return null;
    try { return Number(await p.request({ method: 'eth_chainId' })); } catch { return null; }
  },
  /**
   * 把钱包切到某条链（不传就是默认链）。
   *
   * **只切"我们部署过的链"**：钱包里没有就 `wallet_addEthereumChain` 加一条 ——
   * 加的是我们自己 RPC / explorer 的那份参数，不是别人的。
   */
  async ensureChain(chain = null) {
    const eth = wallet.provider;
    if (!eth) return;
    const want = chain || CHAIN;
    const now = await wallet.chainId();
    if (now === want.id) return;
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want.hex }] });
    } catch (e) {
      // 4902 = 钱包里没有这条链 —— 加上再切。加上之后钱包通常会自己切过去。
      if (e && (e.code === 4902 || /Unrecognized chain/i.test(String(e.message)))) {
        try {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: want.hex, chainName: want.name,
              nativeCurrency: { name: want.native === 'ETH' ? 'Ether' : want.native, symbol: want.native || 'ETH', decimals: 18 },
              rpcUrls: want.rpcs || [want.rpc],
              blockExplorerUrls: want.explorer ? [want.explorer] : [],
            }],
          });
        } catch (e2) {
          /* Phantom 就是走到这里：它不支持加自定义网络，回 4901。 */
          throw chainRefusedError(want, chainRefused(e2) ? e2 : e);
        }
      } else if (chainRefused(e)) throw chainRefusedError(want, e);
      else throw e;
    }
  },
  signer() {
    const p = wallet.provider;
    if (!p || !window.ethers) throw new Error('no wallet or ethers available');
    return new window.ethers.BrowserProvider(p).getSigner();
  },
};

/**
 * 刷新页面时把 WalletConnect 会话接回来。
 * 放在模块求值的最后一段：它只在"上次用的就是 WalletConnect"时才真的干活（见 wcRestore），
 * 别的访客连那 509 KB 的 bundle 都不会碰。
 */
wcRestore();

/* ── 格式化 ────────────────────────────────────────────────────────────── */
export const short = (a, n = 4) => (a ? `${String(a).slice(0, 2 + n)}…${String(a).slice(-4)}` : '—');
export function fmtAmount(v, decimals = 18, max = 4) {
  try {
    const s = window.ethers.formatUnits(v, decimals);
    const [i, f = ''] = s.split('.');
    const cut = f.slice(0, max).replace(/0+$/, '');
    return cut ? `${Number(i).toLocaleString()}.${cut}` : Number(i).toLocaleString();
  } catch { return '—'; }
}
export function fmtDate(sec) {
  const t = Number(sec) * 1000;
  if (!t || !Number.isFinite(t)) return '—';   // NaN 也要挡住 —— `toISOString()` 会抛 RangeError
  return new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
export function countdown(sec) {
  const ms = Number(sec) * 1000 - Date.now();
  if (ms <= 0) return { done: true, text: 'unlocked' };
  const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60;
  return { done: false, text: d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m` };
}
export const explorer = (path, chain = CHAIN) => `${chain.explorer}${path}`;
/**
 * 外链地址，**没有 explorer 的链回 null**。
 *
 * 本地链（Hardhat 3137）没有浏览器，`explorer` 是空串 —— 硬拼出来的
 * `/tx/0x…` 会变成一条**同源**链接，点进去是同源的 404。
 * 链接检查器会把它当死链报出来（2026-10-11 就是这么发现的）。
 */
export const explorerHref = (path, chain = CHAIN) => (chain && chain.explorer ? `${chain.explorer}${path}` : null);

/* ── 开机片 ──────────────────────────────────────────────────────────────
 * 闸门（每页 <head> 里同步跑的那段，见 oaken-boot-gate）只负责"播不播"——
 * 它给 <html> 挂上 `boot-run`，CSS 立刻铺底色（不闪的机制全在那一条）。
 * 这里负责建覆盖层、放片、拆干净。
 *
 * 三条纪律（[[boot-film-render-and-inject]]，每条都对应一种"页面被锁死/黑屏"的坏法）：
 *   · **任何路径都要收场**：ended / error / 点击 / 键盘 / 12 秒兜底，五条；
 *   · 收场必须**摘 `boot-run`**，否则那层底色永远盖着页面；
 *   · 播放期间把站上别的视频先按停（首页 hero 是同一棵树，省带宽也让片子不抖），
 *     收场后再恢复播放 —— 片子结尾就是 hero 的第一帧，接得上。
 */
export function bootFilm() {
  const html = document.documentElement;
  if (!html.classList.contains('boot-run')) return;
  const el = document.createElement('div');
  el.id = 'boot';
  el.innerHTML = `
    <video muted playsinline preload="auto" src="/app/media/boot-film-cfa9ec41.mp4"></video>
    <div class="bt-scrim"></div>
    <div class="bt-title">
      <img src="/oaken/ic-oaken.svg" alt="">
      <b>OAKEN</b>
      <span>Some things should not move.</span>
    </div>
    <div class="bt-skip">click to skip</div>`;
  document.body.appendChild(el);
  const v = el.querySelector('video');
  const others = [...document.querySelectorAll('video[data-video]')].filter((x) => !el.contains(x));
  for (const o of others) { try { o.pause(); } catch { /* 没在放就算了 */ } }
  let done = false;
  const finish = (why = 'done') => {
    if (done) return;
    done = true;
    html.dataset.bootReason = why;          // 收场原因写在 <html> 上 —— 排查时一眼看得到
    el.classList.add('bt-out');
    setTimeout(() => {
      el.remove();
      html.classList.remove('boot-run');
      for (const o of others) { const p = o.play(); if (p && p.catch) p.catch(() => {}); }
    }, 620);
  };
  /* 起播之前覆盖层是**底色**（不是黑框）：片子在缓冲时先看见树皮色，
     等真的能放了再淡进来（信号是 playing，不是 loadeddata —— 后者还没开始放）。 */
  v.addEventListener('playing', () => el.classList.add('ready'));
  v.addEventListener('ended', () => finish('done'));
  v.addEventListener('error', () => finish('error'));
  /* 字标浮出的时机**跟着片子走**（播到 4.4 秒 = 第三镜"树洞的光"里），
     不用 CSS 的 animation-delay —— 那是从元素创建算的，缓冲慢的时候字会先于画面出来。 */
  const titleEl = el.querySelector('.bt-title');
  const onTime = () => { if (v.currentTime >= 4.4) { titleEl.classList.add('on'); v.removeEventListener('timeupdate', onTime); } };
  v.addEventListener('timeupdate', onTime);
  el.addEventListener('click', () => finish('skip'));
  window.addEventListener('keydown', () => finish('skip'), { once: true });
  /* 慢线路：8 秒还没起播就体面收场（别让人盯着底色等）；总兜底 18 秒。 */
  setTimeout(() => { if (!el.classList.contains('ready')) finish('slow'); }, 8000);
  setTimeout(() => finish('timeout'), 18000);
  const p = v.play();
  if (p && p.catch) p.catch(() => finish('noplay'));
}

/**
 * 这一页跑的是哪一版 —— 取 CSS 链接上的 `?v=`（发布时现算的内容哈希）。
 * 页脚印出来（footer 里那个 `${buildId()}`），报"还是旧的"时一眼能分责：版本号对 = 新版到了；
 * ⚠ 注释写在模板字符串**里面**会被当成输出的一部分（`_cjk-visible` 直接把它算成"用户可见的中文"）。
 * 版本号旧 = 浏览器/缓存还端着旧页面（按 Ctrl+F5）。取不到就写 `dev`，不编。
 */
function buildId() {
  try {
    /* ⚠ 取 **oaken.js** 的哈希，不是 CSS 的：改一行 JS 它就得变，否则这个号不是判据
       （第一版取的是 CSS 链接上的 ?v= —— 只改 JS 时它纹丝不动，等于没用）。 */
    const src = [...document.querySelectorAll('script[type=module]')].map((x) => x.textContent || '').join('');
    const m = /\/app\/oaken\.js\?v=([0-9a-f]{6,})/.exec(src);
    if (m) return 'build ' + m[1].slice(0, 8);
    const link = document.querySelector('link[href*="/app/oaken.css"]');
    const m2 = link && /[?&]v=([0-9a-f]{6,})/.exec(link.getAttribute('href'));
    return m2 ? 'build ' + m2[1].slice(0, 8) : 'dev';
  } catch { return 'dev'; }
}

/* ── 外壳：顶栏 + 页脚 ─────────────────────────────────────────────────── */
export function shell({ active } = {}) {
  /**
   * **第一件事**：告诉页面"脚本跑起来了"。
   *
   * 每页 <head> 里还有一段**非模块**的看门狗（`oaken-boot-watch`）：7 秒后如果这个记号
   * 还没出现，它就把静态占位（"Reading…" / "Loading…"）换成一句能照做的话 + 第一行错误。
   * 它管的是我复现不了的那一类：**页面脚本压根没跑**（缓存里的旧 HTML、被拦的模块、
   * 解析失败）—— 那时用户盯着的是**静态 HTML 里的字**，看不出是在等还是坏了。
   *
   * 放在函数最开头，抢在任何可能抛的东西之前。
   */
  try { document.documentElement.dataset.oakenBoot = '1'; } catch { /* 老到没有 dataset 就算了 */ }
  /* 全局复制（一次就够，所有页面共用）：`[data-copy]` 的值写进剪贴板。
     失败不装作成功 —— 按钮文字如实说 "press Ctrl+C"。 */
  if (!window.__oakenCopyWired) {
    window.__oakenCopyWired = true;
    document.addEventListener('click', async (ev) => {
      const btn = ev.target && ev.target.closest && ev.target.closest('[data-copy]');
      if (!btn) return;
      const text = btn.dataset.copy;
      let ok = await copy(text);
      if (!ok) {
        /* 第二层：老的 execCommand —— **不需要页面焦点**（clipboard API 在页面没焦点时会拒，
           真浏览器里切换标签回来也有窗口）。和锁币页那个复制按钮同一套兜底。 */
        try {
          const ta = document.createElement('textarea');
          ta.value = text; ta.setAttribute('readonly', '');
          ta.style.cssText = 'position:fixed;left:-9999px;top:0';
          document.body.appendChild(ta); ta.select();
          ok = document.execCommand('copy'); ta.remove();
        } catch { ok = false; }
        if (!ok) {
          /* 真失败时把邻近那段文字**选中** —— 不然"press Ctrl+C"是一句空话（什么都没选中，
             按了也没用）。选中之后 Ctrl+C 立刻就有用。 */
          try {
            const host = btn.closest('dd') || btn.parentElement;
            if (host) {
              const range = document.createRange();
              range.selectNodeContents(host);
              const sel = window.getSelection();
              sel.removeAllRanges(); sel.addRange(range);
            }
          } catch { /* 选不动就只留提示 */ }
        }
      }
      const labelEl = btn.querySelector('span') || btn;
      const old = labelEl.textContent;
      labelEl.textContent = ok ? 'copied ✓' : 'press Ctrl+C';
      setTimeout(() => { labelEl.textContent = old; }, 1400);
    });
  }
  const link = (href, label, on) => `<a href="${href}" class="${on ? 'on' : ''}">${label}</a>`;
  const header = `
    <header class="top"><div class="wrap topbar">
      <a class="brand" href="/"><img src="/oaken/ic-oaken.svg" alt=""><b>OAKEN</b></a>
      <nav class="main">
        <!-- Launchpad is our launch page; the captured sale snapshot lives at /launchpads (linked from there). -->
        ${link('/launch', 'Launchpad', active === 'launch')}
        ${link('/launches', 'Launches', active === 'launches')}
        ${link('/names', 'Names', active === 'names')}
        ${link('/locks', 'Locks', active === 'locks')}
        ${link('/tools', 'Tools', active === 'tools')}
        ${link('/bonds', 'Bonds <span class="pill" style="font-size:10px;padding:2px 6px;margin-left:4px;vertical-align:1px" title="Bonds has a 2-of-3 Safe admin — Locks do not">admin</span>', active === 'bonds')}
        ${link('/activity', 'Activity', active === 'activity')}
        ${link('/leaderboard', 'Leaderboard', active === 'leaderboard')}
        ${link('/me', 'My OAKEN', active === 'me')}
      </nav>
      <div class="right">
        <!-- Gas balance appears here after a wallet connects; it is not rendered while disconnected. -->
        <button class="chip gaschip" id="gas-chip" type="button" title="Your gas balance" style="display:none"></button>
        <a class="icon-btn" href="https://x.com/oakenhood" target="_blank" rel="noopener" aria-label="OAKEN on X">${icon('x', 16)}</a>
        <a class="icon-btn" href="https://github.com/OAKEN-spec/OAKEN-spec" target="_blank" rel="noopener" aria-label="OAKEN source on GitHub" title="Source code on GitHub">${icon('github', 16)}</a>
        <button class="btn btn-p" id="connect">${icon('wallet', 16)}<span>Connect</span></button>
        <!-- Chain switcher sits on the far right, away from the nav. -->
        <button class="chip" id="chain-chip" type="button" title="Network"><span class="dot"></span><b>${CHAIN.name}</b><span class="cid"> · ${CHAIN.id}</span></button>
      </div>
    </div></header>`;
  const footer = `
    <footer class="bottom"><div class="wrap">
      <span class="mono" style="letter-spacing:.14em;color:var(--gold)">OAKEN.ONE</span>
      <span>·</span>
      <a href="/about">About</a>
      <span>·</span>
      <a href="/faq">FAQ</a>
      <span>·</span>
      <a href="/verify">Verify</a>
      <span>·</span>
      <a href="/dashboard">Dashboard</a>
      <span>·</span>
      <a href="/security">Security</a>
      <span>·</span>
      <a href="/docs">Docs</a>
      <span>·</span>
      <a href="/terms">Terms</a>
      <span>·</span>
      <a href="/privacy">Privacy</a>
      <span>·</span>
      <a href="https://x.com/oakenhood" target="_blank" rel="noopener">@oakenhood</a>
      <span>·</span>
      <a href="https://github.com/OAKEN-spec/OAKEN-spec" target="_blank" rel="noopener">GitHub</a>
      <span class="sp">Locks and balances are read from the chain the site is on, or from our own index.
        Sale listings are the captured snapshot that ships with this build — and every page says which of the two it is showing.
        No protocol fee on locks or our own factory: you pay gas only. Verification is not an audit.</span>
      <span class="mono" style="opacity:.65" title="the build this page is running">${buildId()}</span>
    </div></footer>`;
  /**
   * ⚠ 页眉进 `#shell`，**页脚挂到 body 末尾**。
   * 第一版把两个都塞进 `#shell`，而 `#shell` 在 `<main>` 前面 ——
   * 于是页脚出现在**内容上方**（截图里一眼就看出来）。
   */
  const host = document.getElementById('shell');
  if (host) {
    host.innerHTML = header;
    if (host.dataset.footer !== 'off') document.body.insertAdjacentHTML('beforeend', footer);
    /* 导航滑线：悬停滑到那一项下面，移开滑回当前页那项（没有当前项就淡出）。
       放在 shell() 里 —— 顶栏的 DOM 就是在这里生成的，别的页面没有第二次机会。 */
    const nav = host.querySelector('nav.main');
    if (nav) {
      const ind = document.createElement('i');
      ind.className = 'nav-ind';
      nav.appendChild(ind);
      const active = nav.querySelector('a.on');
      const place = (el) => {
        if (!el || !el.offsetWidth) { ind.classList.remove('live'); return; }
        ind.classList.add('live');
        ind.style.width = `${el.offsetWidth}px`;
        ind.style.transform = `translateX(${el.offsetLeft}px)`;
      };
      /* 只认**一级导航项**（nav 的直接子 a）—— 子菜单里的 a 不该把滑线拽走 */
      nav.addEventListener('mouseover', (e) => {
        const a = e.target.closest('a');
        if (a && a.parentElement === nav) place(a);
      });
      nav.addEventListener('mouseleave', () => place(active));
      /* 字体是异步换上的（swap）—— 字号变了宽度就变，摆早了线是歪的 */
      requestAnimationFrame(() => place(active));
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => place(active));

      /* 子菜单（悬停展开）：Locks / Tools 各一组。
         顶栏是第一级，这里展开的是第二级；第三级在各自页面里（工具四页互相有返回链接）。 */
      const SUBS = {
        '/locks': [['/locks', 'All locks', 'everything currently held'],
                   ['/locks/create', 'Create a lock', 'tokens or LP, with a schedule'],
                   ['/locks/robinhood/position', 'Lock a position', 'Uniswap V3 / V4 NFTs'],
                   ['/locks/solana', 'Solana locks', 'SPL tokens, one unlock date']],
        '/tools': [['/tools/multisender', 'MultiSender', 'one tx, four hundred recipients'],
                   ['/tools/token', 'Token factory', 'fixed supply, no owner'],
                   ['/tools/airdrop', 'Airdrop', 'a merkle list that pays its own claims'],
                   ['/tools/presale', 'Presale', 'soft and hard caps, refunds work']],
      };
      const sub = document.createElement('div');
      sub.className = 'nav-sub';
      nav.appendChild(sub);
      let hideT = 0;
      const showSub = (anchor, items) => {
        clearTimeout(hideT);
        sub.innerHTML = items.map(([href, t, d]) => `<a href="${href}"><b>${t}</b><span>${d}</span></a>`).join('');
        sub.style.left = `${anchor.offsetLeft}px`;
        sub.classList.add('open');
      };
      const hideSub = () => { hideT = setTimeout(() => sub.classList.remove('open'), 160); };
      for (const a of nav.querySelectorAll('a')) {
        const items = SUBS[a.getAttribute('href')];
        if (!items) continue;
        a.classList.add('has-sub');
        a.addEventListener('mouseenter', () => showSub(a, items));
        a.addEventListener('mouseleave', hideSub);
      }
      sub.addEventListener('mouseenter', () => clearTimeout(hideT));
      sub.addEventListener('mouseleave', hideSub);
    }
  }
  wireWallet();
  wireChain();
  motion();     // v3：顶栏滚动态 / 进度发丝线 / 视频管理（幂等，一次）
  reveal();
  bootFilm();   // 开机片最后建 —— 它会把 motion() 刚催起来的视频先按停（见函数头注释）
}

/**
 * 钱包是不是停在一条**我们没部署的链**上（`wireChain` 每次跑都更新）。
 *
 * 两个用处，都是"如实"：
 *   · 顶栏那颗胶囊改写成动作（Switch to …）；
 *   · **gas 余额那一格藏起来** —— 那个数是从**我们的链**读的（`currentChain()`），
 *     钱包在别的链上时它根本不是用户钱包里的钱，摆着就是误导。
 *   （顺带：1440 宽的顶栏为此腾出位置，不然那颗更长的胶囊会顶住导航。）
 */
let _wrongNet = false;

/** 连接按钮：连上之后显示短地址；点开是一个小面板（复制地址 / 断开）。 */
async function wireWallet() {
  const btn = document.getElementById('connect');
  if (!btn) return;
  /* gas 那一格的重画在模块级（`paintGas`）—— 换链流程也要用同一份逻辑 */
  const paint = async (addr) => {
    paintGas(addr);
    if (!addr) { btn.innerHTML = `${icon('wallet', 16)}<span>Connect</span>`; btn.classList.add('btn-p'); btn.classList.remove('btn-s'); return; }
    btn.classList.remove('btn-p'); btn.classList.add('btn-s');
    btn.innerHTML = `${icon('check', 15)}<span class="mono">${short(addr)}</span>`;
    btn.dataset.addr = addr;
  };
  const [addr] = await wallet.accounts();
  /* 用户主动断开过就不画回已连接（钱包里仍记着授权，但我们答应过"断开"） */
  await paint(walletOff() ? null : addr);
  /* gas 那个小标签点开就是同一个钱包面板（复制 / 浏览器 / 换一把 / 断开）——
     它不是第二个入口，只是把"余额"这一件事摆在明面上。 */
  const gasChip = document.getElementById('gas-chip');
  if (gasChip) gasChip.onclick = () => { if (gasChip.dataset.addr) wallet.menu(gasChip); };
  /**
   * gas 余额**自己刷** —— 每 30 秒一次，切回标签页时再来一次。
   *
   * 为什么要有：余额只在"连上/换地址"那一笔画一次，之后锁完一笔、领完一笔，顶上那个数
   * 纹丝不动 —— 看着就是坏的（PinkSale 那套是 10 秒轮询；我们没那么急，但得动）。
   * 只读、不弹窗，读不到 paintGas 自己写 `—`。
   */
  setInterval(() => { if (btn.dataset.addr && !document.hidden) paintGas(btn.dataset.addr); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && btn.dataset.addr) paintGas(btn.dataset.addr); });
  btn.onclick = async () => {
    // 连上之后点按钮 = 打开小面板（复制 / 浏览器 / 换一把 / 断开）
    if (btn.dataset.addr) { wallet.menu(btn); return; }
    btn.disabled = true;
    /**
     * 按钮在**面板开着的时候保持 "Connect"** —— 那会儿钱包那边什么都没发生，
     * 写 "Check your wallet…" 是骗人的。真正该写的是"已选好钱包、正在请它授权"那一段，
     * 由 `activate()` 通过 `onWallet('phase')` 通知（见下面那行订阅）。
     * 用户关掉面板时 `connect()` 返回 null —— 画回未连接态，不 toast。
     */
    try {
      const addr = await wallet.connect();
      await paint(addr);
      if (addr) toast('Connected');
    } catch (e) { await paint(null); toast(humanizeWalletError(e), 'bad'); }
    btn.disabled = false;
  };
  /* 面板已关、钱包还没批准的那一小段：按钮如实说在等谁（慢钱包上这一段能有好几秒） */
  onWallet('phase', (busy) => {
    if (busy && !btn.dataset.addr) btn.innerHTML = `${icon('wallet', 16)}<span>Check your wallet…</span>`;
  });
  onWallet('accounts', (addr) => {
    if (addr) setWalletOff(false);
    paint(addr);
    /* 连上/断开之后顶栏那颗网络胶囊也要跟着钱包的链画一次 —— 切链失败时它要变成
       "Switch to …"（activate 不再因为切链失败而中断连接，见那里的注释）。
       事件路径把地址原样传进去，wireChain 不会回查账户（防自激）。 */
    wireChain({ fromEvent: true, account: addr });
  });
  /**
   * ⚠ **只有真的换到"我们认的另一条链"才重载**。
   *
   * 第一版写成 `on('chainChanged', () => location.reload())` —— 而 dev 钱包在每次
   * `eth_accounts` 之后都会**补发一次 chainChanged**（真钱包在授权那一刻也发），
   * 于是页面**自己重载自己**：子资源永远加载不完、shell 永远是空的，
   * 而控制台一条错都没有。排查它花的时间比写这一页还多。
   *
   * 多链之后判据也跟着变：不是"不等于默认链就重载"，而是"**换到了另一条我们部署过的链**
   * 才重载"（页面内容跟着链走）；换到一条我们没部署的链不重载 —— 那由顶栏的
   * 网络标签去提示，页面手上的数据仍然是对的。
   *
   * 2026-10-12：监听改走 `onWallet`（钱包模块按**当前 provider** 挂，连上/换钱包后
   * 自动接上）—— 只认 `window.ethereum` 的那版在多钱包下会挂错对象。
   */
  onWallet('chain', async (hex) => {
    const id = Number(hex);
    const live = await chains();
    if (id !== _shownChainId && live.some((c) => c.id === id)) {
      /* 换到我们认的另一条链：页面数据要跟着换。
         注册过 `onChainSwitch` 的页面自己重画（不再白闪一下），没注册的照旧整页重来。 */
      applyChainChange(id);
    } else { _shownChainId = id; wireChain(); paintGas(btn.dataset.addr); }
  });
}

/**
 * 顶栏那个网络标签：显示**当前用哪条链**，并且（有多条链时）点开能换。
 *
 * 「自动识别」在这里落地：钱包在哪条链，`currentChain()` 就选哪条；钱包在一条我们
 * 没部署的链上时，标签变成"wrong network"，点它就切到我们认的链上。
 * 只有一条链时它就是个标签 —— 不做可以点但点开只有一个选项的假控件。
 */
/** 链菜单的壳：定位、点外面关闭。返回 null 表示这次点击是在关菜单。 */
function showChainMenu(chip, html) {
  const old = document.getElementById('chain-menu');
  if (old) { old.remove(); return null; }
  const menu = document.createElement('div');
  menu.id = 'chain-menu';
  menu.className = 'chain-menu';
  menu.innerHTML = html;
  document.body.appendChild(menu);
  const r = chip.getBoundingClientRect();
  menu.style.top = `${r.bottom + 8}px`;
  menu.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
  setTimeout(() => document.addEventListener('click', function off(ev) {
    if (!menu.contains(ev.target) && ev.target !== chip) { menu.remove(); document.removeEventListener('click', off); }
  }), 0);
  return menu;
}

/** 当前这一支（页面）对应的 Solana / EVM 页面。 */
function solHref() { return location.pathname.startsWith('/launch') ? '/launch/solana' : '/locks/solana'; }
function evmHref() { return location.pathname.startsWith('/launch') ? '/launch' : '/locks'; }

async function wireChain(opts = {}) {
  const chip = document.getElementById('chain-chip');
  if (!chip) return;
  /* Solana 页：顶栏显示 Solana；菜单里仍然能回 EVM 页面。
     Solana 钱包不是 EVM 钱包，"换链"在这里是换页面，不是 wallet_switchEthereumChain。 */
  if (document.body.classList.contains('sol-page')) {
    const live = await chains();
    chip.classList.remove('warn');
    chip.style.cursor = 'pointer';
    chip.innerHTML = `<span class="chain-ico">${chainIcon('solana', 13)}</span><b>Solana</b><span class="cid"> · mainnet</span>`;
    chip.title = 'Solana uses Phantom / Solflare. Pick an EVM chain to open its page instead.';
    chip.onclick = () => {
      const menu = showChainMenu(chip,
        `<button type="button" data-sol="1" class="on"><span class="chain-ico">${chainIcon('solana', 14)}</span><b>Solana</b><span class="muted">mainnet-beta</span></button>`
        + live.map((c) => `<button type="button" data-id="${c.id}"><span class="chain-ico">${chainIcon(c.id, 14)}</span><b>${c.name}</b><span class="muted">${c.native} · ${c.id}</span></button>`).join('')
        + '<div class="hint" style="padding:10px 12px 4px">EVM chains open the EVM page and use the EVM wallet. Solana uses its own wallet (Phantom / Solflare / Backpack / Glow).</div>');
      if (!menu) return;
      menu.querySelector('button[data-sol]').onclick = () => menu.remove();
      for (const b of menu.querySelectorAll('button[data-id]')) {
        b.onclick = () => {
          const c = live.find((x) => x.id === Number(b.dataset.id));
          if (c) setSiteChain(c.id);
          location.href = evmHref();
        };
      }
    };
    return;
  }
  const live = await chains();
  const active = await currentChain();
  /**
   * **"钱包停在哪条链"只在真的连着的时候才看**（2026-10-24）。
   *
   * 钱包扩展在**没授权**时也会答 `eth_chainId` —— 以前这里直接读，于是任何装了
   * Phantom/MetaMask、从没连过本站的人，一打开页面就被顶栏 prompt 一次切链；
   * Phantom 还会回 4901，屏幕上先弹一条红字。
   *
   * ⚠ **不能无条件在这里调 `wallet.accounts()`**：这个函数会在 accountsChanged 里被调用，
   * 而假钱包（以及部分真钱包）每次 eth_accounts 之后都补发事件 —— 会自激
   * （见 [[dapp-multi-wallet-discovery]]）。所以事件那条路**直接用载荷里的地址**，
   * 绝不回查；只有启动/换链这类非事件路径才问一次。
   */
  let connected;
  if (opts.fromEvent) connected = opts.account != null && !walletOff();
  else {
    try { connected = !!((await wallet.accounts())[0]) && !walletOff(); }
    catch { connected = false; }
  }
  const walletId = connected ? await wallet.chainId() : null;
  const foreign = walletId !== null && live.length && !live.some((c) => c.id === walletId);
  /**
   * 记下"**这套 UI 是按哪条链渲染的**" —— 钱包切链时用它判要不要整个重来。
   *
   * ⚠ 2026-10-16 改：原来 foreign 时记的是**钱包那条链**（比如以太坊 1），于是
   * "连接时把钱包切到 Robinhood Chain"会被判成"链变了"→ **整页重载** ——
   * 而页面数据本来就是按 Robinhood 渲染的（`currentChain()` 在钱包的链不是我们的链时
   * 回落成默认链），那次重载纯属白闪，正是 owner 说的"不连贯"。
   * 现在记的是 `active`（渲染用的那条链）：新链 == 它 → 什么都不用做，只重画顶栏。
   */
  _shownChainId = (active && active.id) ?? null;

  _wrongNet = !!foreign;
  if (!live.length) { chip.title = 'Chain list unavailable'; return; }

  if (foreign) {
    /* gas 那一格这时是**误导**（数是从我们的链读的），收起来也给这颗更长的胶囊腾位置 */
    const g = document.getElementById('gas-chip');
    if (g) { g.style.display = 'none'; g.textContent = ''; }
    /**
     * 钱包在一条我们没部署的链上。
     *
     * **文案必须是"动作"**（2026-10-16 owner 截图问"一直显示这个是什么意思"）——
     * 原先是 `Wrong network`，虽然点开能选链，但**没人看得出它能点**，看着就是坏的。
     * 现在写 "Switch to Robinhood Chain"，点一下直接切（钱包里没这条链会自动添加）——
     * 和 PinkSale 内容区那颗 "Switch to X" 按钮同一个意思，只是长在顶栏这颗胶囊里。
     */
    chip.innerHTML = `${icon('alert', 15)}<b>Switch to ${CHAIN.name}</b>`;
    chip.classList.add('warn');
    chip.title = `Your wallet is on a network OAKEN is not deployed to (chain ${walletId}). Click to switch to ${CHAIN.name}.`;
    chip.style.cursor = 'pointer';
    /**
     * 顺手**主动请一次**（一次会话只问一次）：只连了钱包、没点过 Connect 的人（静默回连那条路）
     * 不会经过 activate()，不请就永远停在这一屏。拒绝（4001）或钱包不认就安静停手 ——
     * 每次翻页都弹窗比不切更烦；用户还可以点上面那颗胶囊自己来。
     */
    let asked = false;
    try { asked = sessionStorage.getItem('oaken.chainasked') === '1'; } catch { /* 隐私模式 */ }
    if (!asked) {
      try { sessionStorage.setItem('oaken.chainasked', '1'); } catch { /* 同上 */ }
      toast(`OAKEN runs on ${CHAIN.name} — switch in your wallet to continue.`);
      try { await wallet.ensureChain(null); }
      catch (e) { toast(humanizeWalletError(e), 'bad'); }
    }
    chip.onclick = async () => {
      chip.disabled = true;
      /* 切成功后钱包自己发 chainChanged，上面那条监听会把页面重载回正轨 */
      try { await wallet.ensureChain(null); toast(`Switching to ${CHAIN.name}…`); }
      catch (e) { toast(humanizeWalletError(e), 'bad'); }
      chip.disabled = false;
    };
    return;
  }
  {
    chip.classList.remove('warn');
    chip.innerHTML = `<span class="chain-ico">${chainIcon(active.id, 13)}</span><b>${active.name}</b><span class="cid"> · ${active.id}</span>`;
  }

  if (!live.length && !foreign) { chip.onclick = null; chip.style.cursor = 'default'; return; }
  chip.style.cursor = 'pointer';
  chip.onclick = () => {
    const menu = showChainMenu(chip,
      live.map((c) => `<button type="button" data-id="${c.id}" class="${c.id === active.id && !foreign ? 'on' : ''}">
        <span class="chain-ico">${chainIcon(c.id, 14)}</span><b>${c.name}</b><span class="muted">${c.native} · ${c.id}</span></button>`).join('')
      + '<div style="height:1px;background:var(--line);margin:6px 0"></div>'
      + `<button type="button" data-sol="1"><span class="chain-ico">${chainIcon('solana', 14)}</span><b>Solana</b><span class="muted">mainnet-beta · separate wallet</span></button>`
      + `<div class="hint" style="padding:10px 12px 4px">EVM chains switch the EVM wallet. Solana opens its own page and uses a Solana wallet (Phantom / Solflare / Backpack / Glow).</div>`);
    if (!menu) return;
    menu.querySelector('button[data-sol]').onclick = () => { menu.remove(); location.href = solHref(); };
    for (const b of menu.querySelectorAll('button[data-id]')) {
      b.onclick = async () => {
        const c = live.find((x) => x.id === Number(b.dataset.id));
        menu.remove();
        /* 先记下来 —— 没连钱包时"选一条链"也必须真的换过去（旧行为是重载回默认链，
           看起来像那颗菜单是坏的）。连了钱包的话，下面这一步会把它也切过去。 */
        setSiteChain(c.id);
        try {
          await wallet.ensureChain(c);
          /* 切成功后钱包一般会补一次 chainChanged（那条监听负责重画/重载）；
             有的钱包不补 —— 兜一下：半秒后还没动静就自己应用。 */
          setTimeout(() => { if (_shownChainId !== c.id) applyChainChange(c.id); }, 500);
        } catch (e) { toast(String(e.message || e), 'bad'); }
      };
    }
  };
}

/* ── 英文 / 美式的时间选择器 ──────────────────────────────────────────────
 *
 * 为什么自己写一个（2026-10-15 owner 明确要求）：
 * **原生 `<input type="datetime-local">` 的日历弹层跟的是浏览器/系统的语言** ——
 * 页面写 `lang="en"` 也改不动它：中文系统上弹出来就是「2026年11月 / 一二三四五六日 / 清除 / 今天」。
 * Owner 要的是**英文界面 + 美式格式（MM/DD/YYYY，12 小时制 AM/PM）**，所以这里自建一个。
 *
 * 关键的兼容取舍：**输入框的 `.value` 仍然是 `YYYY-MM-DDTHH:mm`（本地时间）** ——
 * 页面上十几处 `new Date($('date').value)` 一个字都不用改。
 * 变的是**显示**：给旁边挂一行美式格式的回显（`11/14/2026 08:38 PM · your local time`），
 * 输入框本身改成只读文本框（点它弹出我们自己的日历，不再触发原生那个中文弹层）。
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** `YYYY-MM-DDTHH:mm`（本地）→ 美式显示 `MM/DD/YYYY hh:mm AM/PM`。 */
export function usDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const p2 = (n) => String(n).padStart(2, '0');
  return p2(d.getMonth() + 1) + '/' + p2(d.getDate()) + '/' + d.getFullYear()
    + ' ' + p2(h) + ':' + p2(d.getMinutes()) + ' ' + ap;
}
const isoOf = (y, m, d, h, min) => y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0')
  + 'T' + String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');

/**
 * 给一个（原本是 datetime-local 的）输入框装上英文 / 美式选择器。
 * 输入框会被改成只读文本框；旁边自动生成一行美式格式回显。
 */
export function mountDatePicker(input, { echo = true } = {}) {
  if (!input || input.dataset.dtpMounted) return;
  input.dataset.dtpMounted = '1';
  input.type = 'text';
  input.readOnly = true;
  input.autocomplete = 'off';
  if (!input.placeholder) input.placeholder = 'MM/DD/YYYY hh:mm AM/PM';

  const host = input.parentElement;
  if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';
  let echoEl = null;
  if (echo) {
    echoEl = document.createElement('div');
    echoEl.className = 'dtp-echo hint';
    input.parentElement.appendChild(echoEl);
  }
  const readValue = () => {
    const d = new Date(input.value);
    const now = new Date();
    if (isNaN(d)) return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate(), h: now.getHours(), min: 0 };
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), min: d.getMinutes() };
  };
  let cur = readValue();
  const syncEcho = () => {
    if (!echoEl) return;
    echoEl.textContent = input.value ? '= ' + usDateTime(input.value) + ' · your local time' : 'No date chosen yet.';
  };
  input.addEventListener('input', () => { cur = readValue(); syncEcho(); });
  syncEcho();

  let panel = null;
  const close = () => { if (panel) { panel.remove(); panel = null; document.removeEventListener('click', off); } };
  const off = (ev) => { if (panel && !panel.contains(ev.target) && ev.target !== input) close(); };
  const setValue = (y, m, d, h, min) => {
    cur = { y, m, d, h, min };
    input.value = isoOf(y, m, d, h, min);
    input.dispatchEvent(new Event('input', { bubbles: true }));   // 让页面的校验/摘要跟着刷新
    syncEcho();
    if (panel) paintPanel();
  };

  const paintPanel = () => {
    const first = new Date(cur.y, cur.m, 1);
    const startDow = first.getDay();
    const days = new Date(cur.y, cur.m + 1, 0).getDate();
    const today = new Date();
    const cells = [];
    for (let i = 0; i < startDow; i++) cells.push('<span class="dtp-pad"></span>');
    for (let d = 1; d <= days; d++) {
      const isToday = d === today.getDate() && cur.m === today.getMonth() && cur.y === today.getFullYear();
      cells.push('<button type="button" class="dtp-day' + (d === cur.d ? ' sel' : '') + (isToday ? ' today' : '') + '" data-day="' + d + '">' + d + '</button>');
    }
    const h12 = cur.h % 12 || 12;
    const hours = Array.from({ length: 12 }, (_, i) => '<option value="' + (i + 1) + '"' + (i + 1 === h12 ? ' selected' : '') + '>' + String(i + 1).padStart(2, '0') + '</option>').join('');
    const mins = Array.from({ length: 12 }, (_, i) => i * 5).map((m) => '<option value="' + m + '"' + (m === (cur.min - cur.min % 5) ? ' selected' : '') + '>' + String(m).padStart(2, '0') + '</option>').join('');
    panel.innerHTML =
      '<div class="dtp-head"><button type="button" data-nav="-1" aria-label="Previous month">‹</button>'
      + '<b>' + MONTHS[cur.m] + ' ' + cur.y + '</b>'
      + '<button type="button" data-nav="1" aria-label="Next month">›</button></div>'
      + '<div class="dtp-dow">' + DOW.map((x) => '<span>' + x + '</span>').join('') + '</div>'
      + '<div class="dtp-days">' + cells.join('') + '</div>'
      + '<div class="dtp-time"><select data-h>' + hours + '</select><span>:</span><select data-min>' + mins + '</select>'
      + '<div class="dtp-ampm"><button type="button" data-ap="AM"' + (cur.h < 12 ? ' class="on"' : '') + '>AM</button>'
      + '<button type="button" data-ap="PM"' + (cur.h >= 12 ? ' class="on"' : '') + '>PM</button></div></div>'
      + '<div class="dtp-foot"><button type="button" data-act="today">Today</button>'
      + '<button type="button" data-act="clear">Clear</button>'
      + '<button type="button" class="btn btn-p" data-act="done">Done</button></div>';
    panel.querySelectorAll('[data-nav]').forEach((b) => {
      b.onclick = () => {
        const n = Number(b.dataset.nav);
        cur.m += n;
        if (cur.m < 0) { cur.m = 11; cur.y--; }
        if (cur.m > 11) { cur.m = 0; cur.y++; }
        paintPanel();
      };
    });
    panel.querySelectorAll('[data-day]').forEach((b) => { b.onclick = () => setValue(cur.y, cur.m, Number(b.dataset.day), cur.h, cur.min); });
    panel.querySelector('[data-h]').onchange = (e) => setValue(cur.y, cur.m, cur.d, (Number(e.target.value) % 12) + (cur.h >= 12 ? 12 : 0), cur.min);
    panel.querySelector('[data-min]').onchange = (e) => setValue(cur.y, cur.m, cur.d, cur.h, Number(e.target.value));
    panel.querySelectorAll('[data-ap]').forEach((b) => {
      b.onclick = () => setValue(cur.y, cur.m, cur.d, (cur.h % 12) + (b.dataset.ap === 'PM' ? 12 : 0), cur.min);
    });
    panel.querySelector('[data-act="today"]').onclick = () => {
      const n = new Date();
      setValue(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes());
    };
    panel.querySelector('[data-act="clear"]').onclick = () => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      syncEcho();
      close();
    };
    panel.querySelector('[data-act="done"]').onclick = () => close();
  };

  input.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (panel) { close(); return; }
    panel = document.createElement('div');
    panel.className = 'dtp';
    /**
     * ⚠ 弹层内部的点击**不许冒泡到 document**：里面每点一下就 `paintPanel()` 重画一遍，
     * 而"点外面关闭"的判据是 `panel.contains(ev.target)` —— 重画之后被点的那个元素已经
     * 脱离文档，contains 判 false，弹层会在选完一天的瞬间自己关掉（而且看起来像"没生效"）。
     */
    panel.addEventListener('click', (ev) => ev.stopPropagation());
    cur = readValue();
    input.parentElement.appendChild(panel);
    paintPanel();
    setTimeout(() => document.addEventListener('click', off), 0);
  });
}

/* ── 提示条 ────────────────────────────────────────────────────────────── */
/**
 * 复制到剪贴板，**失败不抛**。
 *
 * `navigator.clipboard.writeText` 在"页面没有焦点"时会被浏览器拒绝
 * （NotAllowedError，实测：无头里点连接按钮必现；真浏览器里切换标签回来也有窗口）。
 * 原来写成 `navigator.clipboard?.writeText(x)` —— 只挡住了"没有 clipboard 对象"，
 * 挡不住返回的 Promise 被拒：那是一个**没人接的 rejection**，控制台一条红字，
 * 用户那头什么都没发生，还以为地址复制成功了。
 */
export async function copy(text) {
  try { await navigator.clipboard.writeText(String(text || '')); return true; }
  catch { return false; }
}

/**
 * 一个"复制"按钮的 HTML。配合 `shell()` 里的**委托监听**使用（`[data-copy]` 一点就复制），
 * 所以任何页面只要把这段字符串拼进去就有复制能力 —— 不用每页各写一遍监听。
 */
export function copyBtn(text, label = 'copy') {
  return '<button class="copybtn" type="button" data-copy="' + String(text).replace(/"/g, '&quot;') + '">'
    + icon('copy', 12) + '<span>' + label + '</span></button>';
}

/* ── 发射记录（浏览器本地缓存 + 全站登记）─────────────────────────────────
 *
 * 第三方路线的发射链上**没有属于我们的登记**（Pons/Flap/four.meme/Genius/Clanker 的
 * 工厂只记它们自己的），只有发射页知道"这一笔是从 OAKEN 发的"。所以发射成功时
 * `publishLaunch()` 往 `/api/launch-record` 报一条 —— 本地写
 * `data/uploads/launches.json`，线上转 `oaken-img` 的 KV；`/launches` 页读这张全站表。
 * localStorage 那一份继续留给 `/me` 做即时缓存（跨设备看不到第三方那半）。
 */
const LAUNCH_KEY = 'oaken.launched'

/**
 * 全站发射登记：POST `/api/launch-record`。
 *
 * 这是给 `/launches` 页的那张**跨链全站表**用的：本地 serve.js 写
 * `data/uploads/launches.json`，线上 Worker 转 `oaken-img` 的 KV。
 * 第三方路线在链上没有属于我们的登记，只有发射页知道「这一笔是从 OAKEN 发的」，
 * 所以由页面自己报一条。**失败不影响发射**，也不阻塞成功面板。
 */
export function publishLaunch({ chainId, token, name, symbol, route, creator, txHash, image } = {}) {
  try {
    const body = JSON.stringify({
      chainId: Number(chainId), token: token || '', name: name || '', symbol: symbol || '',
      route: route || '', creator: creator || '', txHash: txHash || '', image: image || '',
    })
    fetch('/api/launch-record', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true,
    }).catch(() => {})
  } catch { /* 记录失败不影响发射本身 */ }
}

export function recordLaunch({ chainId, token, name, symbol, route, creator, txHash, image }) {
  let next = []
  try {
    const list = launchedHere()
    const key = String(chainId) + ':' + String(token).toLowerCase()
    next = [{ chainId, token, name: name || '', symbol: symbol || '', route: route || '', at: Date.now() },
      ...list.filter((x) => String(x.chainId) + ':' + String(x.token).toLowerCase() !== key)].slice(0, 100)
    localStorage.setItem(LAUNCH_KEY, JSON.stringify(next))
  } catch { /* 隐私模式写不进去 —— 那就不记，别抛 */ }
  publishLaunch({ chainId, token, name, symbol, route, creator, txHash, image })
  return next
}
export function launchedHere() {
  try { const v = JSON.parse(localStorage.getItem(LAUNCH_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

let toastHost = null;
/**
 * 全局提示条。默认 3.2 秒自己消失；带链接/失败的那种多停一会儿（要看一眼再点）。
 *
 * `opts`：
 *   · `ms`     —— 停留毫秒；**0 = 不自动消失**（交易的 Pending 用它，等结果来替换）
 *   · `href`   —— 附一个链接（交易的区块浏览器链接走这里）
 *   · `label`  —— 那个链接的文字，默认 "Open ↗"
 * 返回一个句柄 `{ update, close }` —— 一笔交易从 Pending 走到 Success/Fail 就是
 * 在**同一条**上改字改色，而不是叠三条（叠三条的话用户得自己认哪条是结局）。
 */
export function toast(msg, kind = 'ok', opts = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99;display:flex;flex-direction:column;gap:8px;align-items:center';
    document.body.appendChild(toastHost);
  }
  document.getElementById('toast-menu')?.remove();   // 点击展开的完整哈希面板（见下）
  const el = document.createElement('div');
  el.className = 'toast';
  const paint = (text, k, o = {}) => {
    el.style.cssText = `background:${k === 'bad' ? '#3a1f18' : '#221b15'};border:1px solid ${k === 'bad' ? 'rgba(224,120,95,.5)' : 'rgba(217,163,67,.35)'};`
      + 'color:#f3eadb;padding:11px 16px;border-radius:4px;font-size:13.5px;box-shadow:0 18px 40px -20px #000;max-width:80vw';
    el.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);
    if (o.href) {
      const a = document.createElement('a');
      a.href = o.href; a.target = '_blank'; a.rel = 'noopener';
      a.style.cssText = 'margin-left:10px;color:#d9a343;white-space:nowrap';
      a.textContent = o.label || 'Open ↗';
      el.appendChild(a);
    }
    if (o.actions) for (const x of o.actions) {
      const a = document.createElement('a');
      a.href = x.href; a.className = 'btn btn-s';
      a.style.cssText = 'margin-left:10px;padding:4px 10px;font-size:12.5px';
      a.textContent = x.label;
      if (/^https?:/.test(x.href)) { a.target = '_blank'; a.rel = 'noopener'; }
      el.appendChild(a);
    }
  };
  let timer = 0;
  const life = (ms) => {
    clearTimeout(timer);
    if (ms > 0) timer = setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, ms);
  };
  paint(msg, kind, opts);
  toastHost.appendChild(el);
  life(opts.ms ?? (kind === 'bad' || opts.href || opts.actions ? 6000 : 3200));
  return {
    el,
    update(text, k = 'ok', o = {}) {
      paint(text, k, o);
      el.style.transition = ''; el.style.opacity = '';
      life(o.ms ?? (k === 'bad' || o.href || o.actions ? 6000 : 3200));
    },
    close() { clearTimeout(timer); el.remove(); },
  };
}

/**
 * 一笔交易的全局通知：**Pending（带浏览器链接）→ Success / Fail**，同一条改到底。
 *
 * 为什么要有它：各页原先各自往某个 `<div class="hint">` 里写一行字，用户切走一眼
 * 就再也找不到"我那笔到底成没成"。清单第 3 条要的是全站统一的一条流。
 *
 * ⚠ 提交那一刻**还没有哈希**（钱包弹窗还没批），所以 `pending()` 不带链接；
 * 拿到 `tx.hash` 之后立刻 `sent(hash)`，这时链接就有了 —— 后面每 3 秒看一眼收据，
 * 上块了就自己变 Success（页面即使不再管它，用户也能看到结局）。
 */
export function txNotice(chain, label, { watch = null } = {}) {
  const known = (h) => (h ? explorerHref('/tx/' + h, chain) : null);
  const h = toast(label + ' — confirm it in your wallet…', 'ok', { ms: 0 });
  let hash = null;
  let settled = false;
  const settle = (fn) => { if (!settled) { settled = true; fn(); } };
  const out = {
    /** 钱包已签名、交易已发出 —— 从这一刻起有哈希可点。 */
    sent(hashHex, extra = '') {
      hash = hashHex;
      h.update(label + ' sent — waiting for the block…' + extra, 'ok', { ms: 0, href: known(hash), label: 'View tx ↗' });
    },
    ok(msg, actions = []) {
      settle(() => h.update(msg || (label + ' confirmed.'), 'ok', { ms: 8000, href: known(hash), label: 'View tx ↗', actions }));
    },
    fail(msg) { settle(() => h.update(msg, 'bad', { ms: 12_000, href: known(hash), label: hash ? 'View tx ↗' : null })); },
    update(msg) { h.update(msg, 'ok', { ms: 0, href: known(hash), label: hash ? 'View tx ↗' : null }); },
    /** 交给人肉兜底：`tx.wait()` 挂住时，轮询收据自己收场（页面不用再等）。 */
    async watch(tx) {
      out.sent(tx.hash);
      const done = await tx.wait();
      out.ok(label + ' confirmed.');
      return done;
    },
    hash: () => hash,
  };
  if (watch) out.watch(watch);
  return out;
}

/* ── 进入视口编排（视觉 v3 的动效引擎）─────────────────────────────────
 *
 *   ① `.reveal` 元素进视口 → .in（CSS 负责淡入/上浮/去模糊）
 *   ② `[data-stagger]` 容器的**直接子元素**自动挂 .reveal 并错峰（--d）
 *   ③ 进度条（.bar i 带内联 width）：先把内联宽度收进 data-w、压到 0，
 *      宿主 reveal 时再生长回去 —— "数字从链上读来"配合"条子长出来"
 *   ④ `[data-count]`：进视口时数字滚动到 data-count 的值（真链读数专用）
 *
 *   ⚠ 这个函数**每画完一轮都要重跑**（页面异步贴完 DOM 后自己调 reveal()），
 *     所以每一步都得幂等：`data-stagger-done` / `data-w` / `data-cd` 都是这个用途。
 */
export function reveal() {
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (window.__oakenSettleSegs) window.__oakenSettleSegs();   // 分段控件的下划线跟着重画走
  for (const host of document.querySelectorAll('[data-stagger]:not([data-stagger-done])')) {
    host.dataset.staggerDone = '1';
    Array.from(host.children).forEach((kid, i) => {
      kid.classList.add('reveal');
      kid.style.setProperty('--d', (i * 95) + 'ms');
    });
  }
  for (const bar of document.querySelectorAll('.bar i[style*="width"]:not([data-w])')) {
    bar.dataset.w = bar.style.width;
    if (!rm) bar.style.width = '0%';
  }
  const grow = (host) => {
    for (const bar of host.querySelectorAll('.bar i[data-w]')) bar.style.width = bar.dataset.w;
    /* 表格行入场：给行编号（CSS 用它算错峰）。**只对第一次入场生效** ——
       列表每次筛选/翻页都会重排行，不关掉的话每打一个字全表都在闪。 */
    if (host.querySelector('.list tbody tr')) {
      host.dataset.rowin = '1';
      host.querySelectorAll('.list tbody tr').forEach((tr, i) => tr.style.setProperty('--ri', String(i)));
      setTimeout(() => { delete host.dataset.rowin; }, 1600);
    }
  };
  const count = (host) => {
    for (const el of host.querySelectorAll('[data-count]')) {
      if (el.dataset.cd) continue;
      el.dataset.cd = '1';
      countTo(el, Number(el.dataset.count));
    }
  };
  const els = document.querySelectorAll('.reveal:not(.in)');
  const cnts = document.querySelectorAll('[data-count]:not([data-cd])');
  if (!els.length && !cnts.length) return;
  if (!('IntersectionObserver' in window)) {
    els.forEach((e) => { e.classList.add('in'); grow(e); count(e); });
    cnts.forEach((e) => { e.dataset.cd = '1'; countTo(e, Number(e.dataset.count)); });
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      const t = e.target;
      t.classList.add('in');
      grow(t); count(t);
      io.unobserve(t);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  els.forEach((e) => io.observe(e));
  cnts.forEach((e) => io.observe(e));
}

/** 数字滚动（读数是真链来的，落到屏幕上时滚出来 —— 这是"活的"那一半）。 */
export function countTo(el, to, { dur = 1300 } = {}) {
  el = typeof el === 'string' ? document.getElementById(el) : el;
  if (!el || !Number.isFinite(to)) return;
  const fmt = (n) => n.toLocaleString('en-US');
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const from = Number(String(el.textContent).replace(/[^\d.-]/g, ''));
  if (rm || !Number.isFinite(from) || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 4);
    el.textContent = fmt(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * 成功仪式：一条一次性短片 + "Sealed on <chain>"，然后把人交回原来的明细面板。
 *
 * 只在**交易真的落地之后**调用（调用方负责判断）。几条硬规矩：
 *   · 短片绝不循环 —— 这是"锁上"的动作，循环就是反复开锁；
 *   · reduced-motion / 起播失败 → **根本不出现**，返回 false，明细面板照常；
 *   · 关掉之后恢复焦点，不让键盘用户掉在原地；
 *   · 所有动态字符串走 textContent，不拼进 innerHTML。
 */
export function sealMoment({ chain = '', id = null, href = null, title = 'Sealed.' } = {}) {
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (rm || !document.body) return false;
  const html = document.documentElement;
  const prevFocus = document.activeElement;
  const veil = document.createElement('div');
  veil.className = 'seal-veil';
  veil.setAttribute('role', 'dialog');
  veil.setAttribute('aria-modal', 'true');
  veil.setAttribute('aria-label', title);
  veil.innerHTML = `
    <div class="seal-card">
      <button class="seal-close" type="button" aria-label="Close">&times;</button>
      <video muted playsinline preload="auto" poster="/app/media/sealkey.webp">
        <source src="/app/media/sealkey-seal.mp4" type="video/mp4">
      </video>
      <div class="eyebrow">ON CHAIN</div>
      <h3></h3>
      <p></p>
      <div class="actions">
        ${href ? '<a class="btn btn-p" data-record>Open the record &rarr;</a>' : ''}
        <button class="btn btn-s" type="button" data-close>Continue</button>
      </div>
    </div>`;
  veil.querySelector('h3').textContent = title;
  veil.querySelector('p').textContent = id
    ? `Lock #${id} is written on ${chain}. The schedule lives in the contract, not in our database.`
    : `The transaction is written on ${chain}. The record is already live.`;
  const rec = veil.querySelector('[data-record]');
  if (rec && href) rec.setAttribute('href', href);
  document.body.appendChild(veil);
  html.classList.add('seal-open');
  requestAnimationFrame(() => veil.classList.add('in'));
  const v = veil.querySelector('video');
  const close = () => {
    veil.classList.remove('in');
    html.classList.remove('seal-open');
    try { v.pause(); } catch { /* 已经停了就算了 */ }
    setTimeout(() => veil.remove(), 460);
    if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch { /* 元素可能已经没了 */ } }
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey);
  veil.addEventListener('click', (ev) => {
    if (ev.target === veil || ev.target.closest('[data-close]') || ev.target.closest('.seal-close')) close();
  });
  v.addEventListener('error', close, { once: true });
  /* 短片放完停住，把焦点交给 Continue —— 键盘用户不用再找出口 */
  v.addEventListener('ended', () => {
    const b = veil.querySelector('[data-close]');
    if (b) b.focus({ preventScroll: true });
  }, { once: true });
  const p = v.play();
  if (p && p.catch) p.catch(() => close());
  setTimeout(() => { const b = veil.querySelector('[data-close]'); if (b) b.focus({ preventScroll: true }); }, 60);
  return true;
}

/** 全站一次性接线：顶栏滚动态、顶部进度发丝线、视频播放管理。 */
export function motion() {
  if (window.__oakenMotion) return;
  window.__oakenMotion = true;
  const header = document.querySelector('header.top');
  const prog = document.createElement('div');
  prog.className = 'scroll-progress';
  document.body.appendChild(prog);
  let raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const y = window.scrollY || 0;
      if (header) header.classList.toggle('scrolled', y > 24);
      const span = document.documentElement.scrollHeight - window.innerHeight;
      prog.style.transform = `scaleX(${span > 40 ? Math.min(1, y / span) : 0})`;
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  /* 视频：进视口才播、离开就停（省电，也让 below-fold 的片子不抢带宽）。
     `prefers-reduced-motion` 时一帧都不播 —— poster 就是那帧。 */
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const vids = document.querySelectorAll('video[data-video]');
  if (vids.length) {
    if (rm) { for (const v of vids) { try { v.pause(); } catch {} } }
    else if ('IntersectionObserver' in window) {
      const vio = new IntersectionObserver((entries) => {
        for (const e of entries) {
          const v = e.target;
          if (e.isIntersecting) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
          else { try { v.pause(); } catch {} }
        }
      }, { rootMargin: '16% 0px' });
      vids.forEach((v) => vio.observe(v));
    }
  }
  /* 分段控件（.seg：All / My locks、链选择…）的滑动下划线：
     悬停滑过去、移开滑回当前项、点击换 .on 之后再对一次位。 */
  const segs = [...document.querySelectorAll('.seg')];
  if (segs.length) {
    const settle = (host) => {
      const ind = host.__segInd;
      const on = host.querySelector('.on');
      if (!ind || !on) return;
      ind.style.width = `${on.offsetWidth}px`;
      ind.style.transform = `translateX(${on.offsetLeft}px)`;
    };
    for (const host of segs) {
      if (host.__segInd) continue;
      const ind = document.createElement('i');
      ind.className = 'seg-ind';
      host.appendChild(ind);
      host.__segInd = ind;
      host.addEventListener('pointerover', (e) => {
        const t = e.target.closest('button, a');
        if (!t || !host.contains(t)) return;
        ind.style.width = `${t.offsetWidth}px`;
        ind.style.transform = `translateX(${t.offsetLeft}px)`;
      });
      host.addEventListener('pointerleave', () => settle(host));
      requestAnimationFrame(() => settle(host));
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => settle(host));
    }
    document.addEventListener('click', () => setTimeout(() => segs.forEach(settle), 0));
    /* 有些 .seg 的按钮是异步画上去的（发射页的链选择）—— reveal() 每次重画都会叫一声 */
    window.__oakenSettleSegs = () => segs.forEach(settle);
  }
  /* ── 纵深：hero 内容/浮尘与暗区环境层的滚动视差 ─────────────────────
     只写两个 CSS 变量，实际位移交给合成器（transform），不改布局。 */
  const hero = document.querySelector('.hero-full');
  const ambs = [...document.querySelectorAll('.band.ambient > .amb')];
  if (!rm && (hero || ambs.length)) {
    let praf = 0;
    const parallax = () => {
      praf = 0;
      const y = window.scrollY || 0;
      if (hero) {
        const hh = hero.offsetHeight || 1;
        document.documentElement.style.setProperty('--hero-y', Math.min(y, hh).toFixed(1) + 'px');
      }
      for (const amb of ambs) {
        const r = amb.parentElement.getBoundingClientRect();
        if (r.bottom < -80 || r.top > window.innerHeight + 80) continue;
        const p = (window.innerHeight - r.top) / (window.innerHeight + r.height);
        amb.style.setProperty('--amb-y', ((p - .5) * 46).toFixed(1) + 'px');
      }
    };
    const onP = () => { if (!praf) praf = requestAnimationFrame(parallax); };
    window.addEventListener('scroll', onP, { passive: true });
    window.addEventListener('resize', onP);
    parallax();
  }
  /* ── 卡片的暖光斑跟着鼠标（只有精确指针才接）────────────────────── */
  if (!rm && matchMedia('(hover: hover) and (pointer: fine)').matches) {
    let sraf = 0;
    document.addEventListener('pointermove', (ev) => {
      const card = ev.target && ev.target.closest && ev.target.closest('.card, .zero, .fcard');
      if (!card || sraf) return;
      const cx = ev.clientX, cy = ev.clientY;
      sraf = requestAnimationFrame(() => {
        sraf = 0;
        const r = card.getBoundingClientRect();
        if (!r.width || !r.height) return;
        card.style.setProperty('--mx', (((cx - r.left) / r.width) * 100).toFixed(1) + '%');
        card.style.setProperty('--my', (((cy - r.top) / r.height) * 100).toFixed(1) + '%');
      });
    }, { passive: true });
  }
  /* ── 路由离场：同源普通链接先淡 190ms 再走 ─────────────────────────
     · 冒泡阶段接，页面自己的 click 处理先跑（preventDefault 的那种就被尊重）；
     · 新标签/下载/外站/锚点/API 一律不碰。 */
  if (!rm && !window.__oakenRouteFade) {
    window.__oakenRouteFade = true;
    document.addEventListener('click', (ev) => {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const a = ev.target && ev.target.closest && ev.target.closest('a[href]');
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      if (a.closest('[data-no-route-fade]')) return;
      let url;
      try { url = new URL(a.getAttribute('href'), location.href); } catch { return; }
      if (url.origin !== location.origin) return;
      if (url.pathname.startsWith('/api/')) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      ev.preventDefault();
      document.documentElement.classList.add('page-leaving');
      setTimeout(() => { location.href = url.href; }, 190);
      /* 兜底：导航被浏览器/扩展拦下时，别把人留在淡出的页面上 */
      setTimeout(() => document.documentElement.classList.remove('page-leaving'), 2600);
    });
  }
  /* 锚点（hero 的 scroll-cue）—— html{scroll-behavior:smooth} 已接管，这里不用做事 */
}

/** hero 的金色浮尘（canvas 2D）：粒子上飘 + 呼吸。reduced-motion 只画一帧。 */
export function emberField(canvas) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, dpr = 1, parts = [], live = true, raf = 0;
  const seed = () => {
    const n = Math.round(Math.min(56, Math.max(26, w / 26)));
    parts = Array.from({ length: n }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: .6 + Math.random() * 1.7, s: .14 + Math.random() * .5,
      a: .08 + Math.random() * .3, ph: Math.random() * Math.PI * 2,
    }));
  };
  const size = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  };
  const draw = (t) => {
    ctx.clearRect(0, 0, w, h);
    for (const p of parts) {
      const tw = .55 + .45 * Math.sin(t / 900 + p.ph);       // 呼吸
      p.y -= p.s; if (p.y < -4) { p.y = h + 4; p.x = Math.random() * w; }
      ctx.beginPath();
      ctx.fillStyle = `rgba(232, 184, 92, ${(p.a * tw).toFixed(3)})`;
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  const loop = (t) => { if (!live) return; draw(t || 0); raf = requestAnimationFrame(loop); };
  size();
  window.addEventListener('resize', size);
  if (rm) { draw(0); return; }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => {
      for (const e of es) {
        live = e.isIntersecting;
        if (live && !raf) raf = requestAnimationFrame(loop);
        if (!live) { cancelAnimationFrame(raf); raf = 0; }
      }
    }, { rootMargin: '10% 0px' }).observe(canvas);
  }
  raf = requestAnimationFrame(loop);
}

/* ── 读链 ────────────────────────────────────────────────────────────────
 * 每个读函数都收一个链（不传就是默认链）—— 多链之后"读哪个合约"必须先知道
 * "读哪条链"，两件事分开传就会拿 A 链的 RPC 去问 B 链。 */
export async function readLock(id, chain = CHAIN, version = 'v1') {
  /**
   * 四组读**并发**发出去，不排队。代币页要按顺序读 11 把锁，一把锁 5 个来回
   * 就是 55 次串行往返 —— 页面上表现为"一直在读"。适配器那份和金库那份互不依赖，
   * 先一起发，拿到 token 再并发读代币元数据 / 可领额度 / LP 标记。
   */
  const a = adapter(chain, null, version);
  const [l, v] = await Promise.all([
    a.getLockById(id),
    vault(chain, null, version).getLock(id).catch(() => null),
  ]);
  const schedOk = !!(v && v.token && v.token !== window.ethers.ZeroAddress);
  const [meta, withdrawable, lp] = await Promise.all([
    tokenMeta(l.token, chain),
    a.withdrawableTokens(id).catch(() => null),
    a.isLpToken(id).catch(() => null),
  ]);
  const [symbol, decimals] = meta;

  /**
   * 排期读**金库**，不从适配器那份 view 反推。
   *
   * 适配器返回的三个数各有各的坑（都会静默）：
   *   · `tgeBps`   —— TGE 当天释放的比例（bps），不是步数；
   *   · `cycle`    —— 间隔，**单位是天**（适配器 `_view` 里已经 `/ 1 days` 过了，
   *                   页面再除一次 86400 就成了 "every 0 days"）；
   *   · `cycleBps` —— 每档释放的比例（bps），不是步数；而且它是 `floor(tail/steps)`，
   *                   **反推回步数是有损的**。
   * 金库的 `getLock` 直接给 `steps` / `endTime` / `cliffTime`，一个都不用猜。
   * 拿不到金库那份（老合约/读失败）才退回适配器的近似值，并且让调用方看得出是近似的。
   */
  const sched = schedOk ? {
    startTime: Number(v.startTime),
    cliffTime: Number(v.cliffTime),
    endTime: Number(v.endTime),
    steps: Number(v.steps),
    tgeBps: Number(v.initialUnlockBps),
    claimed: v.claimed,
    amount: v.amount,
    revocable: v.revocable,
    renounced: v.renounced,
    agent: v.agent,
  } : null;

  const tgeBps = sched ? sched.tgeBps : Number(l.tgeBps);
  const cycleBps = Number(l.cycleBps);
  const cycleDays = Number(l.cycle);   // 适配器给的**就是天**
  const firstRelease = sched ? sched.cliffTime : Number(l.tgeDate);
  // 金库那边拿不到时才反推步数（有损，但总比把它当 bps 显示强）
  const steps = sched ? sched.steps : (cycleBps > 0 ? Math.floor((10_000 - tgeBps) / cycleBps) : 0);
  /**
   * 排期长度：分档是 `steps × 间隔`，一次性是 0（适配器把三者都写成同一个日期）。
   * 记录页的进度环必须按 `endTime` 算 —— 按 `tgeDate` 算的话分档锁一过 TGE 就显示 100%。
   */
  const endTime = sched ? sched.endTime : (steps > 0 ? firstRelease + steps * cycleDays * 86400 : firstRelease);

  return {
    id: String(id), owner: l.owner, token: l.token, amount: sched ? sched.amount : l.amount,
    lockDate: sched ? sched.startTime : Number(l.lockDate),
    unlock: firstRelease, endTime, firstRelease,
    steps, cycleDays, cycleBps, tgeBps, exact: !!sched,
    claimed: sched ? sched.claimed : l.unlockedAmount, withdrawable, description: l.description, lp,
    renounced: sched ? sched.renounced : null, revocable: sched ? sched.revocable : null,
    symbol, decimals, version,
  };
}

/* ── 代币页的批量读（Multicall3）──────────────────────────────────────────
 *
 * 代币页每把锁要 6 个 eth_call（适配器 view + 金库排期 + 代币符号/小数 +
 * 可领额 + LP 标记）。12 把锁 = 70 多个调用，即使 ethers 把它们按 10 个一批
 * 打包，也要十几轮往返，实测首行 4.0 秒。
 *
 * 这里用 Multicall3（每条链都在规范地址 `0xcA11…CA11`）把**整页的读**压成两轮：
 *   ① 适配器 `getLockById` × N
 *   ② 金库 `getLock` × N + 适配器两个 view × N + 每个代币的 symbol/decimals
 * 第一轮的 results 解码后才能知道 token，所以必须两轮，不能一轮。
 *
 * ⚠ **解码失败必须逐条兜住**：空地址的 eth_call 会"成功返回 0x"（本项目的
 *   老熟人），`decodeFunctionResult` 在 0x 上抛；这里每条都 try/catch，
 *   失败的那把按"读不到"计数，页面照旧显示其余的行。整条 Multicall 不可用
 *   （链上没有代码 / 请求失败）时返回 null，调用方退回一把一把读。
 */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MC_ABI = [
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
];
async function aggregate(chain, calls) {
  const iface = new window.ethers.Interface(MC_ABI);
  const raw = await provider(chain).call({ to: MULTICALL3, data: iface.encodeFunctionData('aggregate3', [calls]) });
  const dec = iface.decodeFunctionResult('aggregate3', raw);
  return dec[0] || [];
}

/** 把一把锁的三份读（适配器 view / 金库排期 / 两个标记）拼成页面用的行。 */
function buildLockRow(id, l, x, symbol, decimals, version = 'v1') {
  const hasVault = !!(x.v && x.v.token && x.v.token !== window.ethers.ZeroAddress);
  const sched = hasVault ? {
    startTime: Number(x.v.startTime),
    cliffTime: Number(x.v.cliffTime),
    endTime: Number(x.v.endTime),
    steps: Number(x.v.steps),
    tgeBps: Number(x.v.initialUnlockBps),
    claimed: x.v.claimed,
    amount: x.v.amount,
    revocable: x.v.revocable,
    renounced: x.v.renounced,
    agent: x.v.agent,
  } : null;
  const tgeBps = sched ? sched.tgeBps : Number(l.tgeBps);
  const cycleBps = Number(l.cycleBps);
  const cycleDays = Number(l.cycle);
  const firstRelease = sched ? sched.cliffTime : Number(l.tgeDate);
  const steps = sched ? sched.steps : (cycleBps > 0 ? Math.floor((10_000 - tgeBps) / cycleBps) : 0);
  const endTime = sched ? sched.endTime : (steps > 0 ? firstRelease + steps * cycleDays * 86400 : firstRelease);
  return {
    id, owner: l.owner, token: l.token, amount: sched ? sched.amount : l.amount,
    lockDate: sched ? sched.startTime : Number(l.lockDate),
    unlock: firstRelease, endTime, firstRelease,
    steps, cycleDays, cycleBps, tgeBps, exact: !!sched,
    claimed: sched ? sched.claimed : l.unlockedAmount,
    withdrawable: x.wd ?? null, description: l.description, lp: x.lp ?? null,
    renounced: sched ? sched.renounced : null, revocable: sched ? sched.revocable : null,
    symbol, decimals, version,
  };
}

/**
 * 批量读若干把锁。**返回形状与 `readLock` 逐字段一致**（同一个构造函数），
 * 外加 `failed`：第一轮就没读出来的把数。`null` = 这条链没法用 Multicall3
 * （调用方退回逐把读）。
 */
export async function readLocks(ids, chain = CHAIN, version = 'v1') {
  if (!Array.isArray(ids) || !ids.length) return { rows: [], failed: 0 };
  if (!window.ethers) return null;
  const set = contractSet(version);
  const a = adapter(chain, null, version);
  const v = vault(chain, null, version);
  const ercIface = new window.ethers.Interface(ERC20);

  let r1;
  try {
    r1 = await aggregate(chain, ids.map((id) => ({
      target: set.adapter, allowFailure: true,
      callData: a.interface.encodeFunctionData('getLockById', [id]),
    })));
  } catch { return null; }
  const views = [];
  let failed = 0;
  ids.forEach((id, i) => {
    const r = r1[i];
    if (!r || !r.success) { failed++; return; }
    try { views.push({ id: String(id), l: a.interface.decodeFunctionResult('getLockById', r.returnData)[0] }); }
    catch { failed++; }
  });
  if (!views.length) return { rows: [], failed };

  const tokens = [...new Set(views.map((x) => String(x.l.token).toLowerCase()))];
  const plan = [];
  const calls = [];
  for (const { id } of views) {
    plan.push({ k: 'vault', id }); calls.push({ target: set.vault, allowFailure: true, callData: v.interface.encodeFunctionData('getLock', [id]) });
    plan.push({ k: 'wd', id }); calls.push({ target: set.adapter, allowFailure: true, callData: a.interface.encodeFunctionData('withdrawableTokens', [id]) });
    plan.push({ k: 'lp', id }); calls.push({ target: set.adapter, allowFailure: true, callData: a.interface.encodeFunctionData('isLpToken', [id]) });
  }
  for (const t of tokens) {
    plan.push({ k: 'symbol', t }); calls.push({ target: t, allowFailure: true, callData: ercIface.encodeFunctionData('symbol') });
    plan.push({ k: 'decimals', t }); calls.push({ target: t, allowFailure: true, callData: ercIface.encodeFunctionData('decimals') });
  }
  const r2 = await aggregate(chain, calls);
  const extra = new Map();       // id -> { v?, wd?, lp? }
  const meta = new Map(tokens.map((t) => [t, { symbol: null, decimals: null }]));
  r2.forEach((r, i) => {
    const p = plan[i];
    if (!r || !r.success) return;
    try {
      if (p.k === 'vault' || p.k === 'wd' || p.k === 'lp') {
        const slot = extra.get(p.id) || {};
        if (p.k === 'vault') slot.v = v.interface.decodeFunctionResult('getLock', r.returnData)[0];
        else if (p.k === 'wd') slot.wd = a.interface.decodeFunctionResult('withdrawableTokens', r.returnData)[0];
        else slot.lp = a.interface.decodeFunctionResult('isLpToken', r.returnData)[0];
        extra.set(p.id, slot);
      } else if (p.k === 'symbol') { meta.get(p.t).symbol = ercIface.decodeFunctionResult('symbol', r.returnData)[0]; }
      else if (p.k === 'decimals') { meta.get(p.t).decimals = Number(ercIface.decodeFunctionResult('decimals', r.returnData)[0]); }
    } catch { /* 这一条读不到 —— 保持 null */ }
  });

  const rows = views.map(({ id, l }) => {
    const m = meta.get(String(l.token).toLowerCase()) || { symbol: 'TOKEN', decimals: 18 };
    const symbol = m.symbol == null ? 'TOKEN' : m.symbol;
    const decimals = m.symbol == null || m.decimals == null ? 18 : m.decimals;
    return buildLockRow(id, l, extra.get(id) || {}, symbol, decimals, version);
  });
  return { rows, failed };
}

/**
 * 代币页专用：**只发两轮 Multicall** 拿全整页。
 *
 *   轮 A：`getLocksForToken(token, 0, 1000)` + 代币 symbol + decimals
 *         （`_slice` 会把 end 夹到实际长度，所以不需要先问 count）；
 *   轮 B：每把锁的金库排期 + 可领额 + LP 标记（id 全部来自轮 A）。
 *
 * 适配器的 `PinkLockView` 已经带 `getLockById` 的全部字段，第二轮不用再读适配器。
 * 页面上所有锁都属于同一个代币，symbol/decimals 只问一次。
 * 返回 `null` 表示这条链没有可用的 Multicall3 —— 调用方退回老路径。
 */
export async function tokenLocksPage(token, chain = CHAIN, version = 'v1') {
  if (!window.ethers) return null;
  const set = contractSet(version);
  const a = adapter(chain, null, version);
  const v = vault(chain, null, version);
  const ercIface = new window.ethers.Interface(ERC20);
  let ra;
  try {
    ra = await aggregate(chain, [
      { target: set.adapter, allowFailure: true, callData: a.interface.encodeFunctionData('getLocksForToken', [token, 0, 1000]) },
      { target: token, allowFailure: true, callData: ercIface.encodeFunctionData('symbol') },
      { target: token, allowFailure: true, callData: ercIface.encodeFunctionData('decimals') },
    ]);
  } catch { return null; }
  let views;
  try {
    if (!ra[0] || !ra[0].success) return null;
    views = a.interface.decodeFunctionResult('getLocksForToken', ra[0].returnData)[0] || [];
  } catch { return null; }
  let symbol = 'TOKEN', decimals = 18;
  try {
    symbol = ercIface.decodeFunctionResult('symbol', ra[1].returnData)[0];
    decimals = Number(ercIface.decodeFunctionResult('decimals', ra[2].returnData)[0]);
  } catch { symbol = 'TOKEN'; decimals = 18; }
  const ids = views.map((x) => String(x.id));
  if (!ids.length) return { ids, rows: [], failed: 0, symbol, decimals, version };

  const plan = [];
  const calls = [];
  for (const id of ids) {
    plan.push({ k: 'vault', id }); calls.push({ target: set.vault, allowFailure: true, callData: v.interface.encodeFunctionData('getLock', [id]) });
    plan.push({ k: 'wd', id }); calls.push({ target: set.adapter, allowFailure: true, callData: a.interface.encodeFunctionData('withdrawableTokens', [id]) });
    plan.push({ k: 'lp', id }); calls.push({ target: set.adapter, allowFailure: true, callData: a.interface.encodeFunctionData('isLpToken', [id]) });
  }
  let r2;
  try { r2 = await aggregate(chain, calls); }
  catch { return null; }
  const extra = new Map();
  r2.forEach((r, i) => {
    const p = plan[i];
    if (!r || !r.success) return;
    try {
      const slot = extra.get(p.id) || {};
      if (p.k === 'vault') slot.v = v.interface.decodeFunctionResult('getLock', r.returnData)[0];
      else if (p.k === 'wd') slot.wd = a.interface.decodeFunctionResult('withdrawableTokens', r.returnData)[0];
      else slot.lp = a.interface.decodeFunctionResult('isLpToken', r.returnData)[0];
      extra.set(p.id, slot);
    } catch { /* 这一条读不到 —— 保持 null */ }
  });
  const rows = views.map((l, i) => buildLockRow(ids[i], l, extra.get(ids[i]) || {}, symbol, decimals, version));
  return { ids, rows, failed: 0, symbol, decimals, version };
}

/**
 * 一笔交易的收据 → 金库那条 `LockCreated` 的参数（`lockId` / `amount` 实收 / 排期字段）。
 * 不是我们的交易、或日志里没有它，回 null —— 调用方据此说"没读到"，而不是编一个锁号。
 */
export function lockCreatedFromReceipt(receipt, chain = CHAIN, version = 'v1') {
  const set = contractSet(version);
  const iface = adapter(chain, null, version).interface;
  for (const log of receipt?.logs || []) {
    if (log.address && log.address.toLowerCase() !== set.adapter.toLowerCase()) continue;
    try {
      const p = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (p && p.name === 'LockCreated') return p.args;
    } catch { /* 这条不是我们的事件，下一条 */ }
  }
  return null;
}

/**
 * 原生币余额 —— 用来在签名前说清"gas 从哪来"。读不到回 null（页面显示 `—`，不编 0）。
 */
export async function nativeBalance(chain = CHAIN, address) {
  if (!address) return null;
  try { return await provider(chain).getBalance(address); } catch { return null; }
}

/**
 * 这个地址是不是一笔 Uniswap V2 交易对（LP token）。
 *
 * 判据是它自己答不答得出 `token0()`/`token1()` —— 那是交易对接口，普通 ERC-20 没有。
 * V3 的仓位是 ERC-721，走的是 `PositionLock` 那条线，这里**够不着也不假装够得着**。
 * 探针失败一律回 false：宁可少标一个 LP，不能把普通代币标成 LP。
 */
export async function isV2Pair(chain, address) {
  try {
    const pair = new window.ethers.Contract(address, [
      'function token0() view returns (address)',
      'function token1() view returns (address)',
    ], provider(chain));
    const [a, b] = await Promise.all([pair.token0(), pair.token1()]);
    const zero = window.ethers.ZeroAddress;
    return window.ethers.isAddress(a) && window.ethers.isAddress(b) && a !== zero && b !== zero && a !== b;
  } catch { return false; }
}

/** 标题在链上只存前 31 字节（金库的 label 是 bytes32）—— 超出部分静默丢掉，所以先说出来。 */
export function storedTitle(title) {
  const bytes = new TextEncoder().encode(String(title || ''));
  if (bytes.length <= 31) return { text: String(title || ''), truncated: false };
  return { text: new TextDecoder().decode(bytes.slice(0, 31)), truncated: true };
}

/**
 * 钱包 / RPC 吐出来的报错 → 人话。
 *
 * 合约的 revert 是给机器看的（`Unsupported("token transferFrom")`、`TooManySteps`…），
 * 钱包的 4001 更是只有一个数字。**原文照旧由调用方留着**（放进 #err、放进追踪器），
 * 这里只负责给出一句用户能据此决定下一步的话。
 */
export function humanizeTxError(e, chain = CHAIN) {
  const code = e?.code ?? e?.info?.error?.code;
  const raw = e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
  const native = chain?.native || 'ETH';
  const where = chain?.name || 'this chain';
  if (code === 4001 || code === 'ACTION_REJECTED' || /user rejected|user denied|rejected the request/i.test(raw))
    return 'You rejected it in the wallet — nothing was sent.';
  if (/insufficient funds/i.test(raw)) return 'Not enough ' + native + ' to pay the gas for this transaction.';
  if (/NothingReceived/.test(raw)) return 'The token delivered nothing — it may take a 100% fee on transfer, or the amount is too small to move.';
  if (/Unsupported\("token transferFrom"\)/.test(raw)) return 'The token refused the transfer — check that it is a normal ERC-20 and that you hold it.';
  if (/Unsupported\("token approve"\)/.test(raw)) return 'The token refused the approval — some tokens block that step, and this one cannot be locked here.';
  if (/TooManySteps/.test(raw)) return 'That is more tranches than the vault allows — raise the release % per cycle.';
  if (/UnorderedSchedule/.test(raw)) return 'The dates are out of order.';
  if (/NotAContract/.test(raw)) return 'There is no contract at that token address on ' + where + '.';
  if (/UnknownLock/.test(raw)) return 'That lock id does not exist on ' + where + '.';
  if (/NothingClaimable/.test(raw)) return 'Nothing has vested yet — there is nothing to claim right now.';
  if (/LockRenounced/.test(raw)) return 'This lock was renounced: nobody can claim it any more, including its owner.';
  if (/NotBeneficiary/.test(raw)) return 'This wallet is not the owner of that lock — the vault only listens to the owner.';
  if (/ZeroAmount|AmountTooLarge|InvalidInitialUnlock|ZeroBeneficiary/.test(raw)) return 'The vault rejected those numbers — check the amount and the schedule.';
  if (/estimateGas|exceeds block gas limit|out of gas/i.test(raw)) return 'The transaction could not be estimated on ' + where + ' — nothing was sent.';
  if (/VanityAddressRequirementNotMet/i.test(raw)) return 'The address we mined is no longer the pattern this launcher wants — reload the page and try again.';
  if (/NewTokenV7RuleViolation/i.test(raw)) return 'The launcher rejected one of the launch parameters (a rule it added after its own front end was built). Nothing was sent — tell us and we will match it.';
  if (/PermissionlessCreateDisabled|InvalidSigner|RateLimitExceeded|SpammerBlocked/i.test(raw)) return where + ' has turned public creation off for now. Nothing was sent — use the OAKEN factory route or their own front end.';
  /* Sales / airdrops / launcher: the factory and campaign contracts reject with
     named custom errors. Without these the page showed an empty error line. */
  if (/StartTooFarBack/i.test(raw)) return 'The start time is more than five minutes in the past. Pick a future start.';
  if (/BadWindow/i.test(raw)) return 'The sale window is invalid — the end must be after the start and in the future.';
  if (/BadCaps/i.test(raw)) return 'The caps are invalid — the hard cap must be at least the soft cap.';
  if (/BadLimits/i.test(raw)) return 'The buy limits are invalid — the maximum must be at least the minimum.';
  if (/Underfunded|FundingShortfall/i.test(raw)) return 'The sale is underfunded — provide enough tokens to cover the hard cap at your price.';
  if (/ZeroRate/i.test(raw)) return 'The price must be greater than zero.';
  if (/NoTokensOffered|TokenMissing/i.test(raw)) return 'Enter the token and the amount the sale will offer.';
  if (/TokenCallFailed/i.test(raw)) return 'The token did not answer a balance read — check its address and that it is on ' + where + '.';
  if (/NotStarted/i.test(raw)) return 'The sale has not started yet.';
  if (/NotEnded/i.test(raw)) return 'The sale is still open — it can be finalized after the end time.';
  if (/Ended/i.test(raw)) return 'The sale has ended.';
  if (/BelowMinimum/i.test(raw)) return 'That is below the minimum buy for this sale.';
  if (/AboveMaximum|HardCapReached/i.test(raw)) return 'That is above what this sale allows right now.';
  if (/SoftCapMissed|SaleFailed/i.test(raw)) return 'The soft cap was missed; contributions can be refunded.';
  if (/AlreadyFinalized/i.test(raw)) return 'This sale is already finalized.';
  if (/NotFinalized/i.test(raw)) return 'This sale is not finalized yet.';
  if (/NothingContributed|NothingToClaim/i.test(raw)) return 'There is nothing to claim from this sale.';
  if (/AlreadyClaimed/i.test(raw)) return 'That airdrop row was already claimed.';
  if (/NoCampaign/i.test(raw)) return 'That airdrop campaign does not exist on ' + where + '.';
  if (/DeadlineNotInFuture/i.test(raw)) return 'The claim deadline must be in the future.';
  if (/DeadlineNotPassed/i.test(raw)) return 'The claim deadline has not passed yet — the campaign cannot be swept.';
  if (/InvalidProof/i.test(raw)) return 'That claim proof does not match the published list.';
  if (/CampaignSwept/i.test(raw)) return 'This campaign was swept; unclaimed tokens went back to its creator.';
  if (/LockShareTooHigh/i.test(raw)) return 'The lock share is too high for this launch.';
  if (/NothingToLock/i.test(raw)) return 'The lock share is zero — there is nothing to lock.';
  if (/TokenCreationFailed/i.test(raw)) return 'The token contract could not be created — the launcher rejected it.';
  const trimmed = String(raw || '').trim();
  if (!trimmed || /^execution reverted/i.test(trimmed)) {
    return 'The transaction reverted on ' + where + ' — the contract rejected it. Check the amounts and dates, then try again.';
  }
  return trimmed;
}
export async function tokenMeta(address, chain = CHAIN) {
  try {
    const t = erc20(chain, address);
    const [symbol, decimals] = await Promise.all([t.symbol(), t.decimals()]);
    return [symbol, Number(decimals)];
  } catch { return ['TOKEN', 18]; }
}
export async function locksForToken(token, chain = CHAIN, version = 'v1') {
  const a = adapter(chain, null, version);
  const count = Number(await a.totalLockCountForToken(token));
  if (!count) return [];
  const rows = await a.getLocksForToken(token, 0, count - 1);   // ⚠ 闭区间
  return rows.map((x) => String(x.id));
}

/**
 * 某个地址名下的锁，**链上现读**（`/me` 用它）。
 *
 * 两步：适配器一次给出"我的所有锁"（`normalLocksForUser`，含锁号与金额），
 * 再对每把锁读一次**金库**取排期终点 —— 不从适配器那份反推 `steps`
 * （`cycleBps = floor(tail/steps)` 是有损的，见上面 VAULT_ABI 那段）。
 * 代币元数据按代币地址缓存：同一个人锁同一个代币十一次，只问一次。
 *
 * 读不到的锁**跳过**，不编 —— 调用方看到的条数就是读到的条数。
 */
export async function locksForOwner(chain, address, version = 'v1') {
  const a = adapter(chain, null, version);
  const views = await a.normalLocksForUser(address);
  /**
   * 快路径：一条 Multicall 把每把锁的金库排期 + 代币的 symbol/decimals 一起读回来
   * （25 把锁从 17 个 RPC 请求 / 3.7 秒降到 ~2 个请求）。失败就退回下面逐把读。
   */
  try {
    const batched = await ownerLocksBatched(views, chain, version);
    if (batched) { batched.sort((p, q) => Number(q.id) - Number(p.id)); return batched; }
  } catch { /* 退回逐把读 */ }
  const v = vault(chain, null, version);
  const meta = new Map();
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < views.length) {
      const k = i++;                                  // ⚠ 索引必须当场取走
      const x = views[k];
      const id = String(x.id);
      try {
        const [tok, l] = await Promise.all([
          meta.has(x.token)
            ? meta.get(x.token)
            : tokenMeta(x.token, chain).then((m) => { meta.set(x.token, m); return m; }),
          v.getLock(id).catch(() => null),
        ]);
        const [symbol, decimals] = tok;
        out.push({
          id, token: x.token, symbol, decimals,
          amount: x.amount, claimed: x.unlockedAmount,
          unlock: l ? Number(l.endTime) : Number(x.tgeDate),
          steps: l ? Number(l.steps) : 0,
          description: x.description,
          version,
        });
      } catch { /* 这一把读不到就跳过 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, views.length) }, worker));
  out.sort((p, q) => Number(q.id) - Number(p.id));
  return out;
}

/** `locksForOwner` 的 Multicall 快路径；不可用时回 null。 */
async function ownerLocksBatched(views, chain, version = 'v1') {
  if (!views.length || !window.ethers) return null;
  const set = contractSet(version);
  const v = vault(chain, null, version);
  const ercIface = new window.ethers.Interface(ERC20);
  const tokens = [...new Set(views.map((x) => String(x.token).toLowerCase()))];
  const plan = [];
  const calls = [];
  for (const x of views) {
    plan.push({ k: 'vault', id: String(x.id) });
    calls.push({ target: set.vault, allowFailure: true, callData: v.interface.encodeFunctionData('getLock', [String(x.id)]) });
  }
  for (const t of tokens) {
    plan.push({ k: 'symbol', t }); calls.push({ target: t, allowFailure: true, callData: ercIface.encodeFunctionData('symbol') });
    plan.push({ k: 'decimals', t }); calls.push({ target: t, allowFailure: true, callData: ercIface.encodeFunctionData('decimals') });
  }
  const out = await aggregate(chain, calls);
  const lockOf = new Map();
  const meta = new Map(tokens.map((t) => [t, { symbol: null, decimals: null }]));
  out.forEach((r, i) => {
    const p = plan[i];
    if (!r || !r.success) return;
    try {
      if (p.k === 'vault') lockOf.set(p.id, v.interface.decodeFunctionResult('getLock', r.returnData)[0]);
      else if (p.k === 'symbol') meta.get(p.t).symbol = ercIface.decodeFunctionResult('symbol', r.returnData)[0];
      else meta.get(p.t).decimals = Number(ercIface.decodeFunctionResult('decimals', r.returnData)[0]);
    } catch { /* 这一条读不到 */ }
  });
  return views.map((x) => {
    const l = lockOf.get(String(x.id)) || null;
    const m = meta.get(String(x.token).toLowerCase()) || { symbol: null, decimals: null };
    const good = m.symbol != null && m.decimals != null;
    return {
      id: String(x.id), token: x.token, symbol: good ? m.symbol : 'TOKEN', decimals: good ? m.decimals : 18,
      amount: x.amount, claimed: x.unlockedAmount, version,
      unlock: l ? Number(l.endTime) : Number(x.tgeDate),
      steps: l ? Number(l.steps) : 0,
      description: x.description,
    };
  });
}
export async function totalLocks(chain = CHAIN, version = 'v1') {
  try { return Number(await adapter(chain, null, version).getTotalLockCount()); } catch { return null; }
}

/**
 * 这条链上"被锁着的代币地址"的集合 —— 逐把锁读它的 token 字段。
 *
 * 为什么不读索引：线上**没有索引器**，`/api/v1/lockers` 发的是打包那一刻的快照，
 * 刚锁进去的代币它不知道（首页那个"Distinct tokens"原先就是这么来的，和旁边
 * 从链上读的"锁数"混在一排里，看不出两个数不是一个来源）。
 *
 * 代价是每把锁一次调用，所以**有上限**：`cap` 之上只数前 cap 把，并回 `complete:false`
 * —— 调用方据此把来源写清楚，而不是假装数全了（[[fallback-that-looks-like-real-data]]）。
 */
export async function lockedTokenAddresses(chain = CHAIN, cap = 150, version = 'v1') {
  const n = await totalLocks(chain, version);
  if (!n) return { tokens: new Set(), complete: true, scanned: 0, total: 0 };
  const upto = Math.min(n, cap);
  const set = contractSet(version);
  const a = adapter(chain, null, version);
  /**
   * 快路径：一笔 Multicall 把所有 `getLockById` 读回来（首页的"distinct tokens"
   * 原先 33 把锁要 6 个 worker 跑好几轮；现在一个请求）。失败退回逐把读。
   */
  if (window.ethers) {
    try {
      const out = await aggregate(chain, Array.from({ length: upto }, (_, i) => ({
        target: set.adapter, allowFailure: true,
        callData: a.interface.encodeFunctionData('getLockById', [i + 1]),
      })));
      const tokens = new Set();
      for (const r of out) {
        if (!r || !r.success) continue;
        try {
          const l = a.interface.decodeFunctionResult('getLockById', r.returnData)[0];
          if (l.token) tokens.add(String(l.token).toLowerCase());
        } catch { /* 这一把解不出来就跳过 */ }
      }
      return { tokens, complete: n <= cap, scanned: upto, total: n };
    } catch { /* 退回逐把读 */ }
  }
  const tokens = new Set();
  let i = 0;
  const worker = async () => {
    while (i < upto) {
      const k = i++;                        // ⚠ 索引当场取走，别让两个 worker 拿到同一把
      try {
        const l = await a.getLockById(k + 1);
        if (l.token) tokens.add(String(l.token).toLowerCase());
      } catch { /* 这一把读不到就跳过 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, upto) }, worker));
  return { tokens, complete: n <= cap, scanned: upto, total: n };
}
/** 我们自己的接口（K线以外的列表数据走它；读不到就回空数组，不编）。 */
export async function ownLocks({ limit = 60, chain = CHAIN } = {}) {
  try {
    const r = await fetch(`/api/v1/lockers?chain_id=${chain?.id ?? DEFAULT_CHAIN_ID}&limit=${limit}`);
    const j = await r.json();
    return Array.isArray(j.docs) ? j.docs : [];
  } catch { return []; }
}
