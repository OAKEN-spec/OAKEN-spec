/**
 * 在**真链的 fork** 上把 Uniswap V4 那段跑通：建池 → 铸仓位 → 用我们的 PositionLock 锁住。
 *
 *   npx hardhat run scripts/v4-seed-test.ts --config hardhat.config.ts
 *
 * 为什么在 fork 上做：V4 没有"加流动性"这种简单函数，要自己编
 * `modifyLiquidities` 的动作码 + 参数；编错了不是 revert（安全）就是铸出一个价格离谱的
 * 仓位（花钱）。fork 上可以反复试，一分钱不花，而且读回的是**真合约**的行为。
 *
 * 链上事实（本文件依赖）：
 *   PoolManager     `0x8366a39CC670B4001A1121B8F6A443A643e40951`（4663）
 *   PositionManager `0x58daec3116aae6D93017bAAea7749052E8a04fA7`
 *   Permit2         `0x000000000022D473030F116dDEE9F6B43aC78BA3`
 *   PositionLock    `0xfC9A43c90e0E0d548D95cEf3C77fce802806CbA9`
 */
import { ethers, network } from 'hardhat'

const RPC = 'https://rpc.mainnet.chain.robinhood.com'
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951'
const POSITION_MANAGER = '0x58daec3116aae6D93017bAAea7749052E8a04fA7'
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const POSITION_LOCK = '0xfC9A43c90e0E0d548D95cEf3C77fce802806CbA9'
const TOKEN = '0x3F8f5E3480f8B13E37EF9D7a0b75f9cD7DA490b6'   // 我们自己发的那枚（OLT）
const HOLDER = '0x21b4114C6038d8927e25d6B6F6fA436d1947Da72'   // 它的持有者（fork 里冒充它）

const A = { MINT_POSITION: 0x02, SETTLE_PAIR: 0x0d }

const coder = ethers.AbiCoder.defaultAbiCoder()
const Q96 = 1n << 96n
const sqrtAt = (price: number) => BigInt(Math.floor(Math.sqrt(price) * Number(Q96)))
const tickToSqrt = (tick: number) => sqrtAt(Math.pow(1.0001, tick))

async function main() {
  await network.provider.send('hardhat_reset', [{ forking: { jsonRpcUrl: RPC } }])
  await network.provider.send('hardhat_impersonateAccount', [HOLDER])
  await network.provider.send('hardhat_setBalance', [HOLDER, '0x21e19e0c9bab2400000'])   // 10000 ETH
  const me = await ethers.getSigner(HOLDER)

  const t = new ethers.Contract(TOKEN, ['function symbol() view returns (string)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], me)
  console.log('fork 就绪 · 冒充', HOLDER, '· 持有', ethers.formatUnits(await t.balanceOf(HOLDER), 18), await t.symbol())

  const fee = 3000, ts = 60, tick = 138120
  const poolKey = [ethers.ZeroAddress, TOKEN, fee, ts, ethers.ZeroAddress]
  const sqrtP = sqrtAt(1_000_000)
  const pm = new ethers.Contract(POOL_MANAGER, ['function initialize((address,address,uint24,int24,address) key, uint160 sqrtPriceX96) returns (int24)', 'function extsload(bytes32 slot) view returns (bytes32)'], me)
  const poolId = ethers.keccak256(coder.encode(['tuple(address,address,uint24,int24,address)'], [poolKey]))
  const slot = ethers.keccak256(coder.encode(['bytes32', 'uint256'], [poolId, 6]))
  const priceOf = async () => BigInt(await pm.extsload(slot)) & ((1n << 160n) - 1n)

  console.log('池子建之前 sqrtPriceX96 =', await priceOf())
  const initTx = await pm.initialize(poolKey, sqrtP, { gasLimit: 1_000_000n })
  await initTx.wait()
  console.log('initialize ✓ 现在 =', await priceOf(), '（应为', sqrtP, '）')

  // Permit2 两跳授权
  await (await t.approve(PERMIT2, ethers.MaxUint256, { gasLimit: 200000n })).wait()
  const permit2 = new ethers.Contract(PERMIT2, ['function approve(address token,address spender,uint160 amount,uint48 expiration)'], me)
  await (await permit2.approve(TOKEN, POSITION_MANAGER, (1n << 160n) - 1n, Math.floor(Date.now() / 1000) + 86400 * 30, { gasLimit: 200000n })).wait()
  console.log('Permit2 授权 ✓')

  const amount0 = ethers.parseEther('0.0005')
  const amount1 = ethers.parseUnits('500', 18)
  const sqrtPl = tickToSqrt(136320), sqrtPu = tickToSqrt(139920)
  const l0 = (amount0 * sqrtP / Q96 * sqrtPu / Q96) * Q96 / ((sqrtPu - sqrtP) / Q96)
  const l1 = amount1 * Q96 / (sqrtP - sqrtPl)
  const L = l0 < l1 ? l0 : l1
  const mintParam = coder.encode(
    ['tuple(address,address,uint24,int24,address)', 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
    [poolKey, 136320, 139920, L, amount0, amount1, HOLDER, '0x'])
  const settleParam = coder.encode(['address', 'address'], [ethers.ZeroAddress, TOKEN])
  const unlockData = coder.encode(['bytes', 'bytes[]'], ['0x' + A.MINT_POSITION.toString(16).padStart(2, '0') + A.SETTLE_PAIR.toString(16).padStart(2, '0'), [mintParam, settleParam]])

  const posm = new ethers.Contract(POSITION_MANAGER, [
    'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
    'function nextTokenId() view returns (uint256)',
    'function ownerOf(uint256 tokenId) view returns (address)',
  ], me)
  const before = await posm.nextTokenId().catch(() => null)
  const tx = await posm.modifyLiquidities(unlockData, Math.floor(Date.now() / 1000) + 1800, { value: amount0, gasLimit: 6_000_000n })
  const rc = await tx.wait()
  console.log('modifyLiquidities ✓ gasUsed', rc.gasUsed.toString())
  const after = await posm.nextTokenId().catch(() => null)
  const tokenId = after !== null ? after - 1n : null
  console.log('仓位 NFT：', before, '→', after, tokenId !== null ? '（新的 #' + tokenId + '，owner=' + await posm.ownerOf(tokenId) + '）' : '')
  console.log('池子价格 =', await priceOf())

  if (tokenId !== null) {
    const pl = new ethers.Contract(POSITION_LOCK, [
      'function lockPosition((address nft,uint256 tokenId,address beneficiary,uint64 unlockTime,bool revocable,bytes32 label) p) returns (uint256)',
      'function getLock(uint256) view returns (tuple(address nft,uint256 tokenId,address beneficiary,uint64 unlockTime,bool revocable,bool released,bool reclaimed,bytes32 label,address creator))',
    ], me)
    const lockTx = await pl.lockPosition({ nft: POSITION_MANAGER, tokenId, beneficiary: HOLDER, unlockTime: Math.floor(Date.now() / 1000) + 86400 * 180, revocable: false, label: ethers.encodeBytes32String('V4 seed') }, { gasLimit: 1_000_000n })
    await lockTx.wait()
    console.log('PositionLock ✓ 仓位现在归', await posm.ownerOf(tokenId), '（应为', POSITION_LOCK + '）')
  }
}

main().catch((e) => { console.error('ERR', e.shortMessage || e.message); process.exitCode = 1 })
