/**
 * 56 mainnet smoke test for the Flap-model curve factory.
 *
 *   DEPLOYER_KEY=… npx hardhat run scripts/smoke-curve-56.ts --network bsc
 *
 * Verifies the deployed wiring (token deployer / V2 / V3 / factory binds), then
 * creates one standard and one tax launch and buys a tiny amount on the
 * standard curve. Graduation is intentionally not run here (it needs ~16 BNB
 * and was already validated on a BSC fork against the real Pancake contracts).
 */
import { ethers } from 'hardhat'

const FACTORY = '0x4983CA331Af98197527F5679721635F7e399f170'
const TOKEN_DEPLOYER = '0x7d2947174067739168F26FeA994aBB5aB2A2698e'
const V2 = '0x7A9eb5427ef8284e37EC13B46b007FEb0ba5125A'
const V3 = '0x5c43895F3a2b40a69Bbaa2DFD85B2e7FA723805B'
const PANCAKE_V2_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E'
const PANCAKE_V3_NPM = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const SUPPLY = ethers.parseEther('1000000000')
const H = ethers.parseEther('107036752')


const FACTORY_ABI = [
  'function supply() view returns (uint256)',
  'function virtualTokens() view returns (uint256)',
  'function phantomQuote() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function protocolShareBps() view returns (uint256)',
  'function standardGraduator() view returns (address)',
  'function taxGraduator() view returns (address)',
  'function tokenDeployer() view returns (address)',
  'function launchFee() view returns (uint256)',
  'function createLaunch((string name,string symbol,address creatorFeeRecipient,uint16 creatorTaxBps,bytes32 salt,address[] snipeTaxExempt,bool tax,(uint16 buyTaxBps,uint16 sellTaxBps,uint64 taxDuration,uint16 marketingBps,uint16 deflationBps,uint16 dividendBps,uint16 liquidityBps,address marketingWallet,address dividendWallet,address liquidityWallet) taxParams) p) payable returns (address token, address curve)',
  'event LaunchCreated(address indexed token, address indexed curve, address indexed creator, bool tax)',
]
const CURVE_ABI = [
  'function token() view returns (address)',
  'function virtualTokens() view returns (uint256)',
  'function reservedTokens() view returns (uint256)',
  'function trackedTokens() view returns (uint256)',
  'function trackedQuote() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function protocolShareBps() view returns (uint256)',
  'function buy(uint256 minTokensOut, address recipient) payable returns (uint256)',
  'event Bought(address indexed payer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 creatorTax, uint256 snipeTax)',
]
const ERC20_ABI = ['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']
const TAX_ABI = [
  'function tax() view returns (uint16,uint16,uint64,uint16,uint16,uint16,uint16,address,address,address,address)',
  'function taxStart() view returns (uint64)',
  'function isPool(address) view returns (bool)',
]
const BIND_ABI = ['function factory() view returns (address)']
const V2_ABI = ['function factory() view returns (address)', 'function router() view returns (address)', 'function wbnb() view returns (address)']
const V3_ABI = ['function factory() view returns (address)', 'function positionManager() view returns (address)', 'function wbnb() view returns (address)', 'function poolFee() view returns (uint24)', 'function tickSpacing() view returns (int24)']

let bad = 0
const check = (label, cond, extra = '') => {
  if (!cond) bad++
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`)
}

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('deployer', deployer.address, 'balance', ethers.formatEther(await ethers.provider.getBalance(deployer.address)))
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, deployer)

  const [supply, h, phantom, threshold, fee, share, stdG, taxG, tokenDeployer, launchFee] = await Promise.all([
    factory.supply(), factory.virtualTokens(), factory.phantomQuote(), factory.graduationThreshold(),
    factory.feeBps(), factory.protocolShareBps(), factory.standardGraduator(), factory.taxGraduator(),
    factory.tokenDeployer(), factory.launchFee(),
  ])
  check('supply 1B', supply === SUPPLY)
  check('Flap h = 107,036,752', h === H)
  check('phantom 6.14 / threshold 16', phantom === ethers.parseEther('6.14') && threshold === ethers.parseEther('16'))
  check('fee 1% / protocol 600 bps of it', fee === 100n && share === 600n)
  check('graduators match the deployment', stdG.toLowerCase() === V3.toLowerCase() && taxG.toLowerCase() === V2.toLowerCase())
  check('token deployer', tokenDeployer.toLowerCase() === TOKEN_DEPLOYER.toLowerCase())
  check('launch fee 0', launchFee === 0n)

  const td = new ethers.Contract(TOKEN_DEPLOYER, BIND_ABI, ethers.provider)
  const v2 = new ethers.Contract(V2, V2_ABI, ethers.provider)
  const v3 = new ethers.Contract(V3, V3_ABI, ethers.provider)
  const [tdF, v2F, v3F, v2Router, v2Wbnb, v3Npm, v3Wbnb, v3Fee, v3Spacing] = await Promise.all([
    td.factory(), v2.factory(), v3.factory(), v2.router(), v2.wbnb(), v3.positionManager(), v3.wbnb(), v3.poolFee(), v3.tickSpacing(),
  ])
  check('token deployer bound', tdF.toLowerCase() === FACTORY.toLowerCase())
  check('V2 bound', v2F.toLowerCase() === FACTORY.toLowerCase())
  check('V3 bound', v3F.toLowerCase() === FACTORY.toLowerCase())
  check('V2 router / WBNB', v2Router.toLowerCase() === PANCAKE_V2_ROUTER.toLowerCase() && v2Wbnb.toLowerCase() === WBNB.toLowerCase())
  check('V3 NPM / WBNB / fee / spacing', v3Npm.toLowerCase() === PANCAKE_V3_NPM.toLowerCase() && v3Wbnb.toLowerCase() === WBNB.toLowerCase() && v3Fee === 2500n && v3Spacing === 50n)

  const zeroTax = [0, 0, 0, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress]
  const standard = async () => {
    const salt = ethers.hexlify(ethers.randomBytes(32))
    const tx = await factory.createLaunch([
      'OAKEN Flap Smoke', 'OFSMOKE', deployer.address, 0, salt, [], false, zeroTax,
    ])
    const rc = await tx.wait()
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l) } catch { return null } }).find((e) => e && e.name === 'LaunchCreated')
    if (!ev) throw new Error('no LaunchCreated')
    return { token: ev.args.token, curve: ev.args.curve, rc }
  }

  console.log('\nstandard launch …')
  const s = await standard()
  const sCurve = new ethers.Contract(s.curve, CURVE_ABI, deployer)
  const sToken = new ethers.Contract(s.token, ERC20_ABI, ethers.provider)
  const [sSupply, sBal, sReserved, sTracked, sH] = await Promise.all([
    sToken.totalSupply(), sToken.balanceOf(s.curve), sCurve.reservedTokens(), sCurve.trackedTokens(), sCurve.virtualTokens(),
  ])
  console.log('  token =', s.token, '\n  curve =', s.curve)
  check('standard token supply to curve', sSupply === SUPPLY && sBal === SUPPLY)
  check('Flap virtual token reserve', sH === H)
  const expectedReserved = (SUPPLY + H) * phantom / (phantom + threshold) - H;
  check('reserved matches the curve formula (~199.97M)', sReserved === expectedReserved, sReserved.toString())
  check('all supply tracked', sTracked === SUPPLY)

  console.log('\ntax launch …')
  const tSalt = ethers.hexlify(ethers.randomBytes(32))
  const ttx = await factory.createLaunch([
    'OAKEN Tax Smoke', 'OTSMOOKE', deployer.address, 0, tSalt, [], true,
    [500, 500, 3600, 4000, 2000, 2000, 2000, deployer.address, deployer.address, deployer.address],
  ])
  const trc = await ttx.wait()
  const tev = trc.logs.map((l) => { try { return factory.interface.parseLog(l) } catch { return null } }).find((e) => e && e.name === 'LaunchCreated')
  if (!tev) throw new Error('no tax LaunchCreated')
  console.log('  token =', tev.args.token, '\n  curve =', tev.args.curve)
  check('tax flag in the event', tev.args.tax === true)
  const taxToken = new ethers.Contract(tev.args.token, TAX_ABI, ethers.provider)
  const taxCurve = new ethers.Contract(tev.args.curve, CURVE_ABI, deployer)
  const [cfg, start, tSupply, tBal, tReserved] = await Promise.all([
    taxToken.tax(), taxToken.taxStart(), new ethers.Contract(tev.args.token, ERC20_ABI, ethers.provider).totalSupply(),
    new ethers.Contract(tev.args.token, ERC20_ABI, ethers.provider).balanceOf(tev.args.curve), taxCurve.reservedTokens(),
  ])
  check('tax rates 5% / 5%', cfg[0] === 500n && cfg[1] === 500n)
  check('tax window not started', start === 0n)
  check('tax token supply to curve', tSupply === SUPPLY && tBal === SUPPLY)
  check('tax curve reserved matches the formula', tReserved === expectedReserved)
  check('commission receiver = deployer', cfg[10].toLowerCase() === deployer.address.toLowerCase())

  console.log('\nbuy 0.0002 BNB on the standard curve …')
  const amount = ethers.parseEther('0.0002')
  const buy = await sCurve.buy(0, deployer.address, { value: amount })
  const brc = await buy.wait()
  const bought = brc.logs.map((l) => { try { return sCurve.interface.parseLog(l) } catch { return null } }).find((e) => e && e.name === 'Bought')
  if (!bought) throw new Error('no Bought')
  const [q, tracked, curveBal, buyerBal, shareBps] = await Promise.all([
    sCurve.trackedQuote(), sCurve.trackedTokens(), sToken.balanceOf(s.curve), sToken.balanceOf(deployer.address), sCurve.protocolShareBps(),
  ])
  const feeExpected = (amount * 100n) / 10000n
  check('1% fee, no snipe for creator', bought.args.fee === feeExpected && bought.args.snipeTax === 0n)
  check('tracked quote = amount - fee', q === amount - feeExpected)
  check('curve token balance = tracked', curveBal === tracked && tracked === SUPPLY - bought.args.tokensOut)
  check('buyer received tokens', buyerBal === bought.args.tokensOut)
  check('protocol share is 600 bps of the fee', shareBps === 600n)

  console.log(`\n${bad === 0 ? '✅' : '❌'} 56 smoke: ${bad} failed`)
  console.log('SMOKE_STD_TOKEN=' + s.token)
  console.log('SMOKE_STD_CURVE=' + s.curve)
  console.log('SMOKE_TAX_TOKEN=' + tev.args.token)
  console.log('SMOKE_TAX_CURVE=' + tev.args.curve)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
