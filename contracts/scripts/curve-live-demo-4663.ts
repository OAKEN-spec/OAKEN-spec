/**
 * A fresh live launch on the deployed Robinhood Chain (4663) OAKEN Curve
 * factory, used as a real on-chain demonstration for the launch post.
 *
 *   DEPLOYER_KEY=… npx hardhat run scripts/curve-live-demo-4663.ts --network robinhood
 *
 * One Pons-model launch + one tiny buy. A demo token, not an official project.
 * Graduation is not run. The launch tx also initializes the real Uniswap V4 pool.
 */
import fs from 'fs'
import path from 'path'
import { ethers } from 'hardhat'

const FACTORY = '0x8D59368a7C369bEf20458442027bE0D9aD6C4F5f'
const GRADUATOR = '0x62E707d5cfe2cD9f029af2A93B2ADfB66976e800'
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951'
const FACTORY_ABI = [
  'function createLaunch((string name,string symbol,address creatorFeeRecipient,uint16 creatorTaxBps,bytes32 salt,address[] snipeTaxExempt) p) payable returns (address token, address curve)',
  'event LaunchCreated(address indexed token, address indexed curve, address indexed creator, string name, string symbol, address creatorFeeRecipient, uint256 creatorTaxBps)',
]
const CURVE_ABI = [
  'function trackedQuote() view returns (uint256)',
  'function trackedTokens() view returns (uint256)',
  'function reservedTokens() view returns (uint256)',
  'function launchSupply() view returns (uint256)',
  'function buy(uint256 minTokensOut, address recipient) payable returns (uint256)',
  'event Bought(address indexed payer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 creatorTax, uint256 snipeTax)',
]
const ERC20_ABI = ['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function name() view returns (string)', 'function symbol() view returns (string)']

async function main() {
  const [deployer] = await ethers.getSigners()
  const before = await ethers.provider.getBalance(deployer.address)
  console.log('deployer', deployer.address, 'balance', ethers.formatEther(before), 'ETH')
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, deployer)
  const salt = ethers.hexlify(ethers.randomBytes(32))
  const tx = await factory.createLaunch([
    'OAKEN Curve Demo', 'OCDEMO', deployer.address, 0, salt, [],
  ])
  console.log('launch tx', tx.hash)
  const rc = await tx.wait()
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l) } catch { return null } })
    .find((e) => e && e.name === 'LaunchCreated')
  if (!ev) throw new Error('no LaunchCreated')
  const { token, curve } = ev.args
  const poolLog = rc.logs.find((l) => l.address.toLowerCase() === POOL_MANAGER.toLowerCase())
  console.log('token', token, '\ncurve', curve, '\nlaunch block', rc.blockNumber, '\nV4 Initialize log', poolLog ? poolLog.topics[0] : '(none)')

  const c = new ethers.Contract(curve, CURVE_ABI, deployer)
  const tokenC = new ethers.Contract(token, ERC20_ABI, ethers.provider)
  const amount = ethers.parseEther('0.0001')
  const buy = await c.buy(0, deployer.address, { value: amount })
  console.log('buy tx', buy.hash)
  const brc = await buy.wait()
  const bought = brc.logs.map((l) => { try { return c.interface.parseLog(l) } catch { return null } })
    .find((e) => e && e.name === 'Bought')
  if (!bought) throw new Error('no Bought')
  const [name, symbol, supply, curveBal, buyerBal, trackedQuote, trackedTokens, reserved, launchSupply, after] = await Promise.all([
    tokenC.name(), tokenC.symbol(), tokenC.totalSupply(), tokenC.balanceOf(curve), tokenC.balanceOf(deployer.address),
    c.trackedQuote(), c.trackedTokens(), c.reservedTokens(), c.launchSupply(), ethers.provider.getBalance(deployer.address),
  ])
  const launchCost = rc.gasUsed * rc.gasPrice
  const buyCost = brc.gasUsed * brc.gasPrice
  const out = {
    at: new Date().toISOString(), chainId: 4663, factory: FACTORY, graduator: GRADUATOR,
    token, curve, name, symbol,
    launchTx: tx.hash, launchBlock: rc.blockNumber, launchGas: rc.gasUsed.toString(), launchCostEth: ethers.formatEther(launchCost),
    v4PoolInitializedInLaunchTx: !!poolLog,
    buyTx: buy.hash, buyBlock: brc.blockNumber, buyGas: brc.gasUsed.toString(), buyCostEth: ethers.formatEther(buyCost),
    buyValueEth: '0.0001', tokensOut: bought.args.tokensOut.toString(), fee: bought.args.fee.toString(), snipeTax: bought.args.snipeTax.toString(),
    supply: supply.toString(), curveTokenBalance: curveBal.toString(), buyerTokenBalance: buyerBal.toString(),
    trackedQuote: trackedQuote.toString(), trackedTokens: trackedTokens.toString(), reservedTokens: reserved.toString(), launchSupply: launchSupply.toString(),
    deployer, deployerBeforeEth: ethers.formatEther(before), deployerAfterEth: ethers.formatEther(after),
    url: 'https://oaken.one/curve/robinhood/' + curve,
    note: 'Public demo token launched through the live OAKEN Curve factory on Robinhood Chain. Not an official project. Graduation not run.',
  }
  const file = path.join(__dirname, '..', '..', 'data', 'curve-live-demo-4663-2026-10-25.json')
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  console.log(JSON.stringify(out, null, 2))
  console.log('report', file)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
