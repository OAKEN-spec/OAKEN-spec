// 四个工具的前端层：合约地址、最小 ABI、默克尔树、名单解析。
//
// 地址是**跨链同址**（确定性部署），所以这里只有一份常量 —— 和 `src/chains.mjs`
// 里的那四个一模一样，`node check.js` 会对账。改了合约地址却忘了改这里，
// 表现是"页面上什么都没有"。
//
// 为什么 ABI 是手写的最小片段、不是搬整份产物：和 `oaken.js` 同一个理由 ——
// 产物里 90% 是内部函数和事件，前端真正调的只有这几个；手写的一眼能读完，
// 而"多写一个函数名"的代价只是没人调它。
import { CHAIN, DEFAULT_CHAIN_ID, erc20, tokenMeta, wallet, toast, provider } from './oaken.js';

export const ADDR = {
  multiSender: '0x1f380ef5eFF9113314Ee175dCE4F226DFd75A50C',
  tokenFactory: '0xc0A3AD1428EeB70cAF88bb89c3B17D0191E1Bd34',
  airdrop: '0x17E9910cDC37BdA5531414012aeA5b0862C22066',
  presaleFactory: '0xAC070cf2ed45aEcb9f5299d4C670fFfCE6387724',
};

/* ── ABI（最小片段）────────────────────────────────────────────────────── */

export const ABI = {
  multiSender: [
    'function MAX_RECIPIENTS() view returns (uint256)',
    'function disperseEther(address[] to, uint256[] amounts) payable',
    'function disperseEtherEqual(address[] to) payable',
    'function disperseToken(address token, address[] to, uint256[] amounts)',
    'function disperseTokenEqual(address token, address[] to, uint256 amountEach)',
    'event Dispersed(address indexed sender, address indexed token, uint256 recipients, uint256 total)',
  ],
  tokenFactory: [
    'function createToken(string name, string symbol, uint8 decimals, uint256 supply) returns (address)',
    'function allTokens() view returns (address[])',
    'function tokenCount() view returns (uint256)',
    'event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint8 decimals, uint256 supply)',
  ],
  airdrop: [
    // ⚠ 结构体要写成 tuple**字段表**，和合约里的声明顺序一致 —— 名字对不上时
    //   ethers 会按位置解，页面拿到 undefined（[[lock-project-37]] 踩过 `getLockById`）。
    'function campaignCount() view returns (uint256)',
    'function campaign(uint256 id) view returns (tuple(address creator, address token, bytes32 root, uint64 deadline, uint128 total, uint128 claimed, uint128 claimedRows, bool swept))',
    'function allCampaigns() view returns (tuple(address creator, address token, bytes32 root, uint64 deadline, uint128 total, uint128 claimed, uint128 claimedRows, bool swept)[])',
    'function createCampaign(address token, bytes32 root, uint256 amount, uint64 deadline) returns (uint256)',
    'function claim(uint256 id, uint256 index, address account, uint256 amount, bytes32[] proof)',
    'function sweep(uint256 id) returns (uint256)',
    'event CampaignCreated(uint256 indexed id, address indexed creator, address indexed token, bytes32 root, uint256 amount, uint64 deadline)',
    'event Claimed(uint256 indexed id, address indexed account, uint256 amount, uint256 index)',
    'event Swept(uint256 indexed id, address indexed creator, uint256 amount)',
  ],
  presaleFactory: [
    'function saleCount() view returns (uint256)',
    'function allSales() view returns (address[])',
    'function createSale(tuple(address token, uint64 startTime, uint64 endTime, uint128 softCap, uint128 hardCap, uint128 minBuy, uint128 maxBuy, uint256 rate, address router, uint16 liquidityBps, uint256 tokensForSale) p) returns (address)',
    'event SaleCreated(address indexed sale, address indexed creator, address indexed token, uint256 tokensForSale)',
  ],
  presale: [
    'function token() view returns (address)',
    'function creator() view returns (address)',
    'function startTime() view returns (uint64)',
    'function endTime() view returns (uint64)',
    'function softCap() view returns (uint128)',
    'function hardCap() view returns (uint128)',
    'function minBuy() view returns (uint128)',
    'function maxBuy() view returns (uint128)',
    'function rate() view returns (uint256)',
    'function router() view returns (address)',
    'function liquidityBps() view returns (uint16)',
    'function raised() view returns (uint128)',
    'function claimedTokens() view returns (uint256)',
    'function finalized() view returns (bool)',
    'function liquidityAdded() view returns (bool)',
    'function contribution(address) view returns (uint128)',
    'function claimed(address) view returns (bool)',
    'function tokensFor(uint256 amount) view returns (uint256)',
    'function promisedTokens() view returns (uint256)',
    'function status() view returns (string)',
    'function buy() payable',
    'function refund()',
    'function finalize()',
    'function claim()',
    'function withdrawUnsold()',
  ],
};

/** 拿一个（或带 signer 的）合约实例。 */
export function contract(chain, key, address, signerOrProvider) {
  return new window.ethers.Contract(address, ABI[key], signerOrProvider || providerFor(chain));
}

/**
 * 只读 provider —— **直接用 oaken.js 那一个**，不再自己建。
 *
 * 原先这里自己 `new JsonRpcProvider(chain.rpc, …)`，用的是注册表里**第一个** URL、
 * 没有超时、也不参与顶层的健康探测与轮换：第一个端点一挂，四个工具页就一起
 * 停在 "Reading…"，而重试按钮轮换的是**另一个** provider 实例，轮了也白轮。
 * （清单第 1 条：全站一套 RPC Fallback —— 那就只能有一个 provider 工厂。）
 */
function providerFor(chain) {
  return provider(chain);
}

/* ── 默克尔树（浏览器这一半）───────────────────────────────────────────────
 *
 * 树形必须和合约里那 8 行**逐字节一致**：
 *   leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))
 *   父   = keccak256(min ‖ max)          ← 排序对，防止换位伪造
 *
 * 前端没有库（项目零依赖），所以这几十行是**我们自己拥有的东西**：合约那边
 * 一份、测试一份、这里一份，三份必须同时对。叶子算错的表现是"每一笔领取都
 * InvalidProof"，链上不报别的错。
 */
const coder = () => new window.ethers.AbiCoder();

export function leafOf(index, account, amount) {
  // 外层那个 keccak 收的是**内层 32 字节哈希的字节**（bytes.concat 的结果），
  // 所以直接喂内层哈希字符串即可 —— 别去 hexlify 再拼，那会多一层。
  const inner = window.ethers.keccak256(
    coder().encode(['uint256', 'address', 'uint256'], [index, account, amount]),
  );
  return window.ethers.keccak256(inner);
}

export function buildTree(rows) {
  const leaves = rows.map((r) => leafOf(r.index, r.account, r.amount));
  const layers = [leaves];
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] ?? a;              // 奇数个时最后一个自己上去
      next.push(a === b ? a : hashPair(a, b));
    }
    layers.push(next);
    level = next;
  }
  const proof = (index) => {
    const out = [];
    let pos = index;
    for (let l = 0; l < layers.length - 1; l++) {
      const layer = layers[l];
      const sib = pos % 2 === 0 ? pos + 1 : pos - 1;
      if (sib < layer.length) out.push(layer[sib]);
      pos = Math.floor(pos / 2);
    }
    return out;
  };
  return { root: level[0] ?? window.ethers.ZeroHash, proof, leaves };
}

function hashPair(a, b) {
  return a.toLowerCase() <= b.toLowerCase()
    ? window.ethers.keccak256(window.ethers.concat([a, b]))
    : window.ethers.keccak256(window.ethers.concat([b, a]));
}

/**
 * 名单文本 → 行。一行一个地址，后面跟数量：
 *
 *   0x1234…     , 100
 *   0x1234…     100
 *
 * 只认这两种分隔（逗号 / 空白）。**重复地址不合并、只报出来** —— "合并"是我们
 * 替用户做的一个决定，而它会让链上那个根和用户心里的名单对不上；报出来让他自己改。
 */
export function parseList(text, decimals = 18) {
  const rows = [];
  const problems = [];
  const seen = new Map();
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split(/[,\s]+/).filter(Boolean);
    if (parts.length < 2) { problems.push(`line ${i + 1}: only one field`); return; }
    const [addr, amountText] = parts;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { problems.push(`line ${i + 1}: not an address (${addr.slice(0, 12)}…)`); return; }
    let amount;
    try { amount = window.ethers.parseUnits(amountText, decimals); } catch { problems.push(`line ${i + 1}: cannot read the amount (${amountText})`); return; }
    if (amount <= 0n) { problems.push(`line ${i + 1}: the amount must be above zero`); return; }
    const key = addr.toLowerCase();
    if (seen.has(key)) problems.push(`line ${i + 1}: this address already appears on line ${seen.get(key)}`);
    else seen.set(key, i + 1);
    rows.push({ index: rows.length, account: addr, amount });
  });
  return { rows, problems };
}

/** 一份"领取文件"：足够别人重建整棵树、把某人那一行挑出来。 */
export function claimFile(chainId, campaignId, token, entries) {
  return {
    kind: 'oaken-airdrop',
    version: 1,
    chainId,
    campaignId,
    token,
    entries: entries.map((e) => ({ account: e.account, amount: e.amount.toString() })),
  };
}

/** 读回一份领取文件，并**重建根**（调用方拿去和链上的根比）。 */
export function readClaimFile(obj) {
  if (!obj || obj.kind !== 'oaken-airdrop' || !Array.isArray(obj.entries)) {
    throw new Error('This is not an airdrop claim file (missing kind: "oaken-airdrop").');
  }
  const rows = obj.entries.map((e, index) => ({ index, account: e.account, amount: BigInt(e.amount) }));
  const { root, proof } = buildTree(rows);
  return { root, proof, rows, file: obj };
}

export function downloadJson(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** `/tools/airdrop/<链>/<id>`、`/tools/presale/<链>/<0x…>` 里的链段 → 链对象。 */
export { CHAIN, DEFAULT_CHAIN_ID };
