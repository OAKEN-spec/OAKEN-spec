// 最小 ABI 编解码 —— 只有这个页面真用到的那几个形状。
//
// ══════════════════════════════════════════════════════════════════════════════
// 为什么手写，而不是打包 ethers
// ══════════════════════════════════════════════════════════════════════════════
//
// 这个镜像里每一 KB 都是量过的，而 ethers 的 UMD 包约 300KB —— 为了调六个
// `uint256` 函数引它，代价和收益不成比例。真正麻烦的那部分（keccak 算选择器）
// **不在这里**:选择器由 `bond/scripts/gen-app.ts` 从编译产物生成进
// `lib/contracts.js`。这个文件只做两件事:**拼 32 字节的字**、**读 32 字节的字**。
//
// ⚠️ 手写编解码的风险是**静默错的**（差一个字节就是另一个函数）。
// 所以这个文件有**交叉验证**:`bond/test/abi.test.ts` 拿它和 ethers 对同一批
// 输入逐个比 —— 判据不是"我觉得对"，是"和 ethers 算出来的一模一样"。
//
// ⚠️ 这个文件**不许 import 任何东西**（它要在浏览器里跑，也是被测试直接吃进去的那份）。

/** BigInt → 32 字节的十六进制字（不含 0x）。负数按二进制补码。 */
export function word(value) {
  let v = BigInt(value)
  if (v < 0n) v += (1n << 256n) // 二进制补码 —— int256 的编码就是这样
  if (v < 0n || v >= (1n << 256n)) throw new Error('Number does not fit in 32 bytes: ' + value)
  return v.toString(16).padStart(64, '0')
}

/** 地址 → 32 字节的字。地址必须是真的 20 字节，**不补全、不猜大小写**。 */
export function addrWord(address) {
  const a = String(address).toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error('Not a valid address: ' + address)
  return a.padStart(64, '0')
}

/** UTF-8 → 十六进制（不带 0x）。string 参数的编码要用。 */
function utf8Hex(s) {
  let out = ''
  for (const b of new TextEncoder().encode(s)) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * 拼一次调用:`0x` + 选择器 + 参数。参数按**类型**决定怎么编码。
 *
 * ⚠️ 动态类型（`bytes` / `string`）在 2026-10-14 加 v1.2 的治理面板时才支持 ——
 *    `Poll.propose(address target, bytes data, string description)` 一个调用里
 *    同时有三种形状。编码规则:头部每个参数占一个字（静态是值，动态是**偏移**），
 *    偏移 = 头部总长 + 排在它前面的尾巴之和。
 *    **估偏移别心算** —— 写错了合约那边报的是"长度不对"，看不出是哪一段。
 */
export function encodeCall(selector, args = [], types = []) {
  if (!/^0x[0-9a-f]{8}$/.test(selector)) throw new Error('Invalid selector shape: ' + selector)
  const isDyn = args.map((_, i) => types[i] === 'bytes' || types[i] === 'string')
  const heads = []
  const tails = []
  let tailBytes = 0
  args.forEach((v, i) => {
    if (!isDyn[i]) { heads.push(types[i] === 'address' ? addrWord(v) : word(v)); return }
    const hex = types[i] === 'bytes' ? String(v).replace(/^0x/, '') : utf8Hex(String(v))
    if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('bytes argument is not hex: ' + String(v).slice(0, 40))
    const padded = hex + '0'.repeat((64 - (hex.length % 64)) % 64)
    heads.push(word(BigInt(args.length * 32 + tailBytes)))
    tails.push(word(BigInt(hex.length / 2)) + padded)
    tailBytes += 32 + padded.length / 2
  })
  return selector + heads.join('') + tails.join('')
}

/** calldata/returndata → 32 字节一块。去 0x，按块切。 */
export function words(hex) {
  const h = String(hex).replace(/^0x/, '')
  const out = []
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64))
  return out
}

/** 第 i 个字当无符号数。 */
export function uintAt(hex, i = 0) {
  const w = words(hex)[i]
  if (w === undefined) throw new Error('Return value has no word at index ' + i)
  return BigInt('0x' + w)
}

/** 第 i 个字当**有符号**数（两补）。 */
export function intAt(hex, i = 0) {
  const v = uintAt(hex, i)
  return v >= (1n << 255n) ? v - (1n << 256n) : v
}

/** 第 i 个字当地址（取低 20 字节）。 */
export function addressAt(hex, i = 0) {
  return '0x' + words(hex)[i].slice(24)
}

/** 第 i 个字当 bool。 */
export function boolAt(hex, i = 0) {
  return uintAt(hex, i) !== 0n
}

/**
 * 第 i 个字是**动态类型**（bytes / string）的偏移：偏移处是长度，然后是数据。
 * 偏移相对的是**参数区起点**（也就是去掉了 0x 的整段开头），不是第 i 个字。
 *
 * ⚠️ 这里只支持"偏移 → 长度 → 数据"这一种布局 —— ABI 里动态类型就这一种，
 *    但我们只拿它解 `Poll.proposalAt` 的 data/description 两个字段，
 *    别的地方（数组、嵌套结构）没验过就别用。
 */
export function bytesAt(hex, i = 0) {
  const h = String(hex).replace(/^0x/, '')
  const off = Number(uintAt(hex, i)) * 2
  const len = Number(BigInt('0x' + h.slice(off, off + 64))) * 2
  return '0x' + h.slice(off + 64, off + 64 + len)
}

/** 同上，按 UTF-8 解成字符串（提案的描述是中文/英文都可能）。 */
export function stringAt(hex, i = 0) {
  const b = bytesAt(hex, i)
  const bytes = new Uint8Array((b.length - 2) / 2)
  for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(b.slice(2 + k * 2, 4 + k * 2), 16)
  return new TextDecoder().decode(bytes)
}

// ── 十进制字符串 ↔ BigInt ────────────────────────────────────────────────────
// 浏览器里没有 ethers 的 parseUnits/formatUnits，而这两件事**必须自己做对**。
// ⚠️ 千万不要用 `Number(x) * 1e18` 那条路:超过 2^53 就开始丢位，
// 而 18 位的代币金额**没有一个是小的**。全程字符串/BigInt。

/** `'1000.5'` + 6 位 → `1000500000n`。 */
export function parseUnits(value, decimals) {
  const s = String(value).trim()
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error('Not a valid number: ' + value)
  const [int = '', frac = ''] = s.split('.')
  if (frac.length > decimals) {
    // 只允许"多出来的全是 0"（用户从别处粘一个 1000.5000000 是正常的）
    if (frac.slice(decimals).replace(/0+$/, '') !== '') throw new Error('Too many decimals: ' + decimals + ' decimal places')
  }
  return BigInt((int || '0') + frac.slice(0, decimals).padEnd(decimals, '0'))
}

/** `1000500000n` + 6 位 → `'1000.5'`（去掉尾零，但不丢精度）。 */
export function formatUnits(value, decimals) {
  const v = BigInt(value)
  const neg = v < 0n
  const s = (neg ? -v : v).toString().padStart(decimals + 1, '0')
  const int = s.slice(0, s.length - decimals)
  let frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '')
}

/** 给界面用的短格式（带千分位，最多 `dp` 位小数）。**只用于显示**，不参与计算。 */
export function pretty(value, decimals, dp = 2) {
  const s = formatUnits(value, decimals)
  const [i, f = ''] = s.split('.')
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = f.slice(0, dp).padEnd(dp, '0')
  return dp > 0 ? grouped + '.' + frac : grouped
}
