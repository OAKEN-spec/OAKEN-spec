/**
 * 4663 mainnet smoke test for the freshly deployed curve factory.
 *
 *   DEPLOYER_KEY=… npx hardhat run scripts/smoke-curve-4663.ts --network robinhood
 *
 * Read the factory terms, create one clearly-labelled test launch, verify the
 * token/curve accounting and that the real Uniswap V4 pool was initialized by
 * the mined hook, then buy a tiny amount and read it all back from the chain.
 */
import { ethers } from 'hardhat'

const FACTORY = '0x8D59368a7C369bEf20458442027bE0D9aD6C4F5f'
const GRADUATOR = '0x62E707d5cfe2cD9f029af2A93B2ADfB66976e800'
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951'
const SUPPLY = ethers.parseEther('1000000000')

const FACTORY_ABI = [
  'function supply() view returns (uint256)',
  'function virtualTokens() view returns (uint256)',
  'function phantomQuote() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function protocolShareBps() view returns (uint256)',
  'function graduator() view returns (address)',
  'function launchFee() view returns (uint256)',
  'function createLaunch((string name,string symbol,address creatorFeeRecipient,uint16 creatorTaxBps,bytes32 salt,address[] snipeTaxExempt) p) payable returns (address token, address curve)',
  'event LaunchCreated(address indexed token, address indexed curve, address indexed creator, string name, string symbol, address creatorFeeRecipient, uint256 creatorTaxBps)',
]
const CURVE_ABI = [
  'function token() view returns (address)',
  'function virtualTokens() view returns (uint256)',
  'function phantomQuote() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function reservedTokens() view returns (uint256)',
  'function trackedTokens() view returns (uint256)',
  'function trackedQuote() view returns (uint256)',
  'function launchSupply() view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'function graduator() view returns (address)',
  'function buy(uint256 minTokensOut, address recipient) payable returns (uint256)',
  'event Bought(address indexed payer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 creatorTax, uint256 snipeTax)',
]
const ERC20_ABI = ['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']
const GRAD_ABI = [
  'function factory() view returns (address)',
  'function poolManager() view returns (address)',
  'function positionManager() view returns (address)',
  'function permit2() view returns (address)',
  'function tickLower() view returns (int24)',
  'function tickUpper() view returns (int24)',
  'function arming() view returns (bool)',
]

let bad = 0
const check = (label, cond, extra = '') => {
  if (!cond) bad++
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`)
}

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('deployer', deployer.address, 'balance', ethers.formatEther(await ethers.provider.getBalance(deployer.address)))
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, deployer)
  const grad = new ethers.Contract(GRADUATOR, GRAD_ABI, ethers.provider)

  const [supply, virtualTokens, phantom, threshold, feeBps, maxTax, share, graduator, launchFee] = await Promise.all([
    factory.supply(), factory.virtualTokens(), factory.phantomQuote(), factory.graduationThreshold(),
    factory.feeBps(), factory.maxCreatorTaxBps(), factory.protocolShareBps(), factory.graduator(), factory.launchFee(),
  ])
  check('factory supply', supply === SUPPLY, supply.toString())
  check('Pons shape (h=0)', virtualTokens === 0n)
  check('phantom 1.68 / threshold 4.2', phantom === ethers.parseEther('1.68') && threshold === ethers.parseEther('4.2'))
  check('fee 1%, creator tax max 1000, protocol share 0', feeBps === 100n && maxTax === 1000n && share === 0n)
  check('graduator is the mined one', graduator.toLowerCase() === GRADUATOR.toLowerCase())
  check('launch fee 0', launchFee === 0n)
  check('hook flags 0x2800', (BigInt(GRADUATOR) & 0x3fffn) === 0x2800n, (BigInt(GRADUATOR) & 0x3fffn).toString(16))
  const [gf, pm, posm, permit2, tl, tu] = await Promise.all([
    grad.factory(), grad.poolManager(), grad.positionManager(), grad.permit2(), grad.tickLower(), grad.tickUpper(),
  ])
  check('graduator bound to the factory', gf.toLowerCase() === FACTORY.toLowerCase())
  check('V4 pool manager', pm.toLowerCase() === POOL_MANAGER.toLowerCase())
  check('full-range ticks', tl === -887200n && tu === 887200n, `${tl}..${tu}`)
  check('permit2 canonical', permit2 === '0x000000000022D473030F116dDEE9F6B43aC78BA3')

  console.log('\ncreating a smoke launch …')
  const salt = ethers.hexlify(ethers.randomBytes(32))
  const tx = await factory.createLaunch([
    'OAKEN Curve Smoke', 'OCSMOKE', deployer.address, 0, salt, [],
  ])
  const rc = await tx.wait()
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l) } catch { return null } })
    .find((e) => e && e.name === 'LaunchCreated')
  if (!ev) throw new Error('no LaunchCreated event')
  const tokenAddr = ev.args.token
  const curveAddr = ev.args.curve
  console.log('  token =', tokenAddr, '\n  curve =', curveAddr)

  const curve = new ethers.Contract(curveAddr, CURVE_ABI, deployer)
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, ethers.provider)
  const [tSupply, curveBal, cToken, cReserved, cTracked, cPhantom, cThreshold, cReady, cGrad, cLaunch] = await Promise.all([
    token.totalSupply(), token.balanceOf(curveAddr), curve.token(), curve.reservedTokens(), curve.trackedTokens(),
    curve.phantomQuote(), curve.graduationThreshold(), curve.readyToGraduate(), curve.graduator(), curve.launchSupply(),
  ])
  check('supply minted to the curve', tSupply === SUPPLY && curveBal === SUPPLY)
  check('curve token matches', cToken.toLowerCase() === tokenAddr.toLowerCase())
  check('launch supply recorded', cLaunch === SUPPLY)
  check('reserved = supply * 1.68 / 5.88', cReserved === (SUPPLY * cPhantom) / (cPhantom + cThreshold), cReserved.toString())
  check('all tokens tracked (reserved included)', cTracked === SUPPLY)
  check('not ready yet', cReady === false)
  check('curve graduator', cGrad.toLowerCase() === GRADUATOR.toLowerCase())

  // The launch transaction carried the real V4 Initialize log from the pool manager.
  const poolInit = rc.logs.find((l) => l.address.toLowerCase() === POOL_MANAGER.toLowerCase())
  check('real V4 pool initialized in the launch tx', !!poolInit, poolInit ? poolInit.topics[0] : '(no PoolManager log)')

  console.log('\nbuying 0.0002 ETH (creator is snipe-exempt) …')
  const amount = ethers.parseEther('0.0002')
  const buy = await curve.buy(0, deployer.address, { value: amount })
  const brc = await buy.wait()
  const bought = brc.logs.map((l) => { try { return curve.interface.parseLog(l) } catch { return null } })
    .find((e) => e && e.name === 'Bought')
  if (!bought) throw new Error('no Bought event')
  const [q, tracked, bal, curveBal2] = await Promise.all([
    curve.trackedQuote(), curve.trackedTokens(), token.balanceOf(deployer.address), token.balanceOf(curveAddr),
  ])
  check('fee is 1% of the buy', bought.args.fee === (amount * 100n) / 10000n, bought.args.fee.toString())
  check('no snipe tax for the creator', bought.args.snipeTax === 0n)
  check('tracked quote = amount - fee', q === amount - bought.args.fee)
  check('tracked tokens decreased by the tokens out', tracked === SUPPLY - bought.args.tokensOut)
  check('curve token balance matches tracked', curveBal2 === tracked)
  check('buyer received the tokens', bal === bought.args.tokensOut)

  console.log(`\n${bad === 0 ? '✅' : '❌'} 4663 smoke: ${bad} failed`)
  console.log('SMOKE_TOKEN=' + tokenAddr)
  console.log('SMOKE_CURVE=' + curveAddr)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
