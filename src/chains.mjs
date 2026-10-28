/**
 * Chain registry.
 *
 * The two lock contracts sit at the SAME address on every chain — that is the
 * whole point of deploying through the deterministic proxy — so their addresses
 * are constants here, not per-chain fields. What varies per chain is only the
 * RPC, the explorer, and the block the contract landed in.
 *
 * `deployBlock` is filled in by `tools/deploy.mjs` when a chain goes live. It
 * stays null on chains we have not deployed to yet, and the indexer skips those
 * rather than scanning from genesis, which on a chain doing 10 blocks a second
 * would be 700 million blocks of nothing.
 *
 * RPCs are public endpoints listed in fallback order. Every one of these was
 * reachable from the build machine when this file was written; the fallbacks
 * exist because public endpoints rate-limit without warning, and a chain that
 * silently stops indexing is worse than one that fails loudly.
 */

/**
 * The deterministic deployment addresses. Identical on every chain: the salt is
 * `keccak256("locker.v1")`, the init code is the compiled contract, and the
 * deployer proxy is at the same address everywhere. Verified end to end in
 * `contracts/test/DeterministicDeploy.test.ts`.
 */
export const LOCK_VAULT = '0xe410d0a21C1376992874a9bEEeE0d623A50D4a34'
export const POSITION_LOCK = '0xfC9A43c90e0E0d548D95cEf3C77fce802806CbA9'

/**
 * The PinkLock-shaped bridge, at its own salt (`adapter.v1`).
 *
 * It exists so the mirrored front end — PinkSale's compiled bundle, which
 * calls PinkLock V2's ABI on whatever address its chain config names — can
 * create locks that land in *our* vault. `contracts/contracts/PinkLockAdapter.sol`
 * has the mapping; what matters here is that it is deterministic too: its one
 * constructor argument is the vault address, which is the same on every chain,
 * so the bridge is as well.
 *
 * Deployed everywhere the vault is (2026-10-11: Robinhood, BNB Chain, Base and
 * Polygon) at the same address on each — the vault address it takes as an
 * argument is itself the same on every chain.
 */
export const PINKLOCK_ADAPTER = '0x16e02A106fE6E978fB98F76756B3a06b4995a7A6'

/**
 * v2 lock contracts (2026-10-23). Same addresses on every chain; the salts are
 * `locker.v2` / `adapter.v2` / `launcher.v2`. v1 above stays live and keeps
 * serving the locks created before v2. The site reads both; a lock row carries
 * the vault address it came from.
 */
export const LOCK_VAULT_V2 = '0xbC511F31967D9EBF775d203661a2BEfF6AA42615'
export const PINKLOCK_ADAPTER_V2 = '0xDBE1f3dc1d6E6759355E1B164231748f0589cb41'
export const OAKEN_LAUNCHER_V2 = '0x0d7cCEA7BabC5e3b4849267740D8fBBe6C4FDa58'

/**
 * v3 lock contracts (2026-10-24). V2 plus the `revoke` clamp — see
 * contracts/v3/README.md. Salts `locker.v3` / `adapter.v3` / `launcher.v3`.
 * New locks and launches use v3; the site still reads v1 and v2 for the locks
 * they hold, because each vault's id space starts at 1.
 */
export const LOCK_VAULT_V3 = '0xd4064d8E73AAB53D7d9efd8A6E8DBE2003d1de4B'
export const PINKLOCK_ADAPTER_V3 = '0x6022DA059FAa0673E3058ADECEef375c2Abfb4A1'
export const OAKEN_LAUNCHER_V3 = '0x4488C369116D0C6FEA84162313c3840976D5A9a5'

/**
 * v4 lock contracts (2026-10-24). The upgradeable continuation of v3: the vault
 * and adapter are ERC1967 proxies; the admin is a 2-of-3 multisig with a 48h
 * delay. These proxy addresses are what the site and the indexer use — an
 * upgrade replaces the implementation slot and leaves these addresses alone.
 * v1–v3 remain immutable and readable for the locks they hold.
 */
export const LOCK_VAULT_V4 = '0x5221A10B772D5e2d51B60E8e3dd5DA9338b04ab0'
export const PINKLOCK_ADAPTER_V4 = '0xA2898528eb4Aea0bDAf47202A5BA3bA4f58F831c'
export const OAKEN_LAUNCHER_V4 = '0x9600f22d2f629904B44c7dA2d958f5AfB3a1e5Ff'
export const V4_MULTISIG = '0xCb847B572352156be50c90FBc752cfd032114666'
export const V4_PROXY_ADMIN = '0xDB998916A34b87c7DA337d922bC1219970FA0319'
export const V4_VAULT_IMPL = '0xEead023bEcE7D6A458c1da1F8c22E84be885171e'
export const V4_ADAPTER_IMPL = '0x33cA492931828B5a8E222fB731BBa1Ab5124cCaA'

/**
 * The tool contracts — batch sending, token creation, airdrops, and the sale
 * factory. Same arrangement as the locks: deployed through the deterministic
 * proxy with a salt that names what the contract is (`multisender.v1`,
 * `airdrop.v1`, …), so the address is a constant here rather than a per-chain
 * field. `contracts/scripts/deterministic-addresses.ts` recomputes them from
 * the compiled bytecode and `node check.js` compares the two.
 */
export const MULTISENDER = '0x1f380ef5eFF9113314Ee175dCE4F226DFd75A50C'
export const TOKEN_FACTORY = '0xc0A3AD1428EeB70cAF88bb89c3B17D0191E1Bd34'
export const AIRDROP = '0x17E9910cDC37BdA5531414012aeA5b0862C22066'
export const PRESALE_FACTORY = '0xAC070cf2ed45aEcb9f5299d4C670fFfCE6387724'

/**
 * 发射台：**发币 + 锁仓在同一笔交易里**完成。
 *
 * 两个构造参数（`TokenFactory` 与 `PinkLockAdapter`）都是跨链同址的常量，
 * 所以它自己也落在同一个地址上。salt = `launcher.v1`。
 *
 * 它调的是**适配器**而不是直连金库 —— 因为"谁有哪些锁"那两张索引表在适配器里
 * （`/me` 与代币页都读它们），直连金库的锁会"记录页看得到、列表页看不到"。
 */
export const OAKEN_LAUNCHER = '0x1d7561fC331594820382E8dd64582645EbafD873'

/** Multicall3, at the address every chain shares. */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'

/**
 * How many blocks one `eth_getLogs` may span, per chain.
 *
 * Robinhood Chain answers `logs matched by query exceed` above 500 and the
 * limit is enforced, not advisory. The rest are set well inside what the public
 * endpoints allow so that a chunk never fails for a reason the retry loop
 * cannot distinguish from a real error.
 */
export const CHAINS = {
  1: {
    chainId: 1,
    slug: 'ethereum',
    name: 'Ethereum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'],
    explorer: 'https://etherscan.io',
    logRange: 2000,
    deployBlock: null,
  },
  56: {
    chainId: 56,
    slug: 'bsc',
    name: 'BNB Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    /**
     * ⚠ 2026-10-11 补 `blxrbdn`（历史档兜底）。publicnode 对**落后链头太远**的
     * `eth_getLogs` 回 403「Archive requests require a personal token」——
     * 和下面 deployBlock 那条注释里 `eth_getTransactionReceipt` 的 403 是同一族。
     * 服务停一晚，BSC 就落到 9 万块之后：主端点够不着、`bsc-dataseed` 每次 20s 超时，
     * **游标从此再不前进，而每一趟只写一行 error**（看起来像链没活动）。
     * blxrbdn 实测能服务该区间（本机 getLogs 会间歇变慢，靠 rpc() 的重试兜住）。
     */
    rpc: ['https://bsc-rpc.publicnode.com', 'https://bsc.rpc.blxrbdn.com', 'https://bsc-dataseed.binance.org'],
    explorer: 'https://bscscan.com',
    logRange: 2000,
    /**
     * Deployed 2026-10-11. The block was **recovered by binary search**, not
     * printed by the deploy tool: the first contract went out, then
     * `bsc-rpc.publicnode.com` answered `eth_getTransactionReceipt` with a 403
     * ("archive requests require a personal token"), so the script died before
     * it could report the block. Re-read later from a node that keeps history
     * (`eth_getTransactionCount` at the deployer's address, bisected). The
     * number is exact, not an estimate.
     */
    deployBlock: 126952960,
    /** `OakenLauncher` 落地的块（发射记录的日志从这里往后扫，别从创世扫）。 */
    launcherBlock: 127210000,
    v2DeployBlock: 129300000,
    v2LauncherBlock: 129320444,
    v3DeployBlock: 129458213,
    v3LauncherBlock: 129458552,
    v4DeployBlock: 129531824,
    v4LauncherBlock: 129531843,
  },
  8453: {
    chainId: 8453,
    slug: 'base',
    name: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    // 同上：mainnet.base.org 会 429（request limit reached）、publicnode 对够不着的区间
    // 回 403 archive —— 落后一千块就卡死。blxrbdn 是实测唯一能读该区间的免费端点。
    rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.rpc.blxrbdn.com'],
    explorer: 'https://basescan.org',
    logRange: 2000,
    deployBlock: 52451144,
    /** `OakenLauncher` 落地的块（发射记录的日志从这里往后扫，别从创世扫）。 */
    launcherBlock: 52509678,
    v2DeployBlock: 52980000,
    v2LauncherBlock: 52983949,
    v3DeployBlock: 53015255,
    v3LauncherBlock: 53015262,
    v4DeployBlock: 53031907,
    v4LauncherBlock: 53031915,
  },
  42161: {
    chainId: 42161,
    slug: 'arbitrum',
    name: 'Arbitrum One',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    explorer: 'https://arbiscan.io',
    logRange: 2000,
    deployBlock: null,
  },
  10: {
    chainId: 10,
    slug: 'optimism',
    name: 'OP Mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
    explorer: 'https://optimistic.etherscan.io',
    logRange: 2000,
    deployBlock: null,
  },
  137: {
    chainId: 137,
    slug: 'polygon',
    name: 'Polygon',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    // 同 56/8453：publicnode 对**稍微落后一点**的区间就回 403 archive（Polygon 上连落后
    // 400 块都拒），tenderly 的公共网关实测能服务这些区间，且
    // blockNumber/getCode/call/batch 都过。
    // `polygon-rpc.com` 从 2026 年起一律 401（API key disabled），**不要放回列表**：
    // 浏览器端 probeChain 会并发探每一个 URL，放一个死的进去就是每次开页一条
    // 控制台 401（2026-10-26 全站自检抓到）。
    rpc: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.gateway.tenderly.co'],
    explorer: 'https://polygonscan.com',
    logRange: 2000,
    deployBlock: 95324432,
    /** `OakenLauncher` 落地的块（发射记录的日志从这里往后扫，别从创世扫）。 */
    launcherBlock: 95402285,
    v2DeployBlock: 96030000,
    v2LauncherBlock: 96034606,
    v3DeployBlock: 96076469,
    v3LauncherBlock: 96076479,
    v4DeployBlock: 96098480,
    v4LauncherBlock: 96098493,
  },
  43114: {
    chainId: 43114,
    slug: 'avalanche',
    name: 'Avalanche C-Chain',
    nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    rpc: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'],
    explorer: 'https://snowtrace.io',
    logRange: 2000,
    deployBlock: null,
  },
  4663: {
    chainId: 4663,
    slug: 'robinhood',
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    // Public endpoints in fallback order. The official endpoint is first
    // because the Node tools and the indexer are its normal client; from
    // Cloudflare's shared egress it answers `eth_call` with 429 almost every
    // time, which is why the rest exist. `robinhood-rpc.publicnode.com` and
    // `robinhood.drpc.org` take single calls but reject JSON-RPC batches;
    // blockvectra and daybreak accept batches. `rpcBatch` puts the batch-
    // capable endpoints first for `callMany`.
    rpc: [
      'https://rpc.mainnet.chain.robinhood.com',
      'https://robinhood-rpc.publicnode.com',
      'https://robinhood.drpc.org',
      'https://api.blockvectra.com/v1/robinhood_mainnet/public',
      'https://robinhood.daybreak-rpc.network',
      'https://rpc.ordofi.network',
      'https://robinhood-mainnet-rpc.blockreq.com/v1/rpc/public',
    ],
    rpcBatch: [
      'https://robinhood.daybreak-rpc.network',
      'https://api.blockvectra.com/v1/robinhood_mainnet/public',
      'https://rpc.mainnet.chain.robinhood.com',
      'https://robinhood-rpc.publicnode.com',
      'https://robinhood.drpc.org',
      'https://rpc.ordofi.network',
      'https://robinhood-mainnet-rpc.blockreq.com/v1/rpc/public',
    ],
    explorer: 'https://robinhoodchain.blockscout.com',
    // Measured: ~10 blocks a second, `eth_getLogs` refuses anything over 500,
    // and a single call costs about half a second. A day is 1,728 queries,
    // which is why the indexer advances a bounded cursor per tick instead of
    // trying to catch up in one invocation.
    logRange: 500,
    deployBlock: 84906377,
    /** `OakenLauncher` 落地的块（发射记录的日志从这里往后扫，别从创世扫）。 */
    launcherBlock: 86679098,
    v2DeployBlock: 95928044,
    v2LauncherBlock: 95928269,
    v3DeployBlock: 96526267,
    v3LauncherBlock: 96526362,
    v4DeployBlock: 96839270,
    v4LauncherBlock: 96840156,
  },
}

/** Chains that have a contract deployed and are therefore indexable. */
export function liveChains() {
  return Object.values(CHAINS).filter((c) => c.deployBlock !== null)
}

/** The `wallet_addEthereumChain` payload, shaped the way every front end here sends it. */
export function addChainParams(chain) {
  return {
    chainId: `0x${chain.chainId.toString(16)}`,
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: chain.rpc,
    blockExplorerUrls: [chain.explorer],
  }
}

export function explorerAddress(chainId, address) {
  const chain = CHAINS[chainId]
  if (!chain) return null
  return `${chain.explorer}/address/${address}`
}

export function explorerTx(chainId, hash) {
  const chain = CHAINS[chainId]
  if (!chain) return null
  return `${chain.explorer}/tx/${hash}`
}
