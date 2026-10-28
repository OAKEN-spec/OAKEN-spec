/**
 * A fresh live launch on the deployed BNB Chain (56) OAKEN Curve factory,
 * used as a real on-chain demonstration for the launch post.
 *
 *   DEPLOYER_KEY=… BSC_RPC_URL=https://bsc-rpc.publicnode.com \
 *     npx hardhat run scripts/curve-live-demo-56.ts --network bsc
 *
 * One standard launch + one tiny buy. A demo token, not an official project.
 * Graduation is not run (it needs ~16 BNB of real buys).
 */
import fs from 'fs'
import path from 'path'
import { ethers } from 'hardhat'

const FACTORY = '0x4983CA331Af98197527F5679721635F7e399f170'
const FACTORY_ABI = [
  'function createLaunch((string name,string symbol,address creatorFeeRecipient,uint16 creatorTaxBps,bytes32 salt,address[] snipeTaxExempt,bool tax,(uint16 buyTaxBps,uint16 sellTaxBps,uint64 taxDuration,uint16 marketingBps,uint16 deflationBps,uint16 dividendBps,uint16 liquidityBps,address marketingWallet,address dividendWallet,address liquidityWallet) taxParams) p) payable returns (address token, address curve)',
  'event LaunchCreated(address indexed token, address indexed curve, address indexed creator, bool tax)',
]
const CURVE_ABI = [
  'function trackedQuote() view returns (uint256)',
  'function trackedTokens() view returns (uint256)',
  'function reservedTokens() view returns (uint256)',
  'function buy(uint256 minTokensOut, address recipient) payable returns (uint256)',
  'event Bought(address indexed payer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 creatorTax, uint256 snipeTax)',
]
const ERC20_ABI = ['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']

async function main() {
  const [deployer] = await ethers.getSigners()
  const before = await ethers.provider.getBalance(deployer.address)
  console.log('deployer', deployer.address, 'balance', ethers.formatEther(before), 'BNB')
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, deployer)
  const salt = ethers.hexlify(ethers.randomBytes(32))
  const zeroTax = [0, 0, 0, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress]

  const tx = await factory.createLaunch([
    'OAKEN Curve Demo', 'OCDEMO', deployer.address, 0, salt, [], false, zeroTax,
  ])
  console.log('launch tx', tx.hash)
  const rc = await tx.wait()
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l) } catch { return null } })
    .find((e) => e && e.name === 'LaunchCreated')
  if (!ev) throw new Error('no LaunchCreated event')
  const { token, curve } = ev.args
  console.log('token', token, '\ncurve', curve, '\nlaunch block', rc.blockNumber)

  const c = new ethers.Contract(curve, CURVE_ABI, deployer)
  const amount = ethers.parseEther('0.0002')
  const buy = await c.buy(0, deployer.address, { value: amount })
  console.log('buy tx', buy.hash)
  const brc = await buy.wait()
  const bought = brc.logs.map((l) => { try { return c.interface.parseLog(l) } catch { return null } })
    .find((e) => e && e.name === 'Bought')
  if (!bought) throw new Error('no Bought event')

  const [supply, curveBal, buyerBal, trackedQuote, trackedTokens, reserved, after] = await Promise.all([
    new ethers.Contract(token, ERC20_ABI, ethers.provider).totalSupply(),
    new ethers.Contract(token, ERC20_ABI, ethers.provider).balanceOf(curve),
    new ethers.Contract(token, ERC20_ABI, ethers.provider).balanceOf(deployer.address),
    c.trackedQuote(), c.trackedTokens(), c.reservedTokens(),
    ethers.provider.getBalance(deployer.address),
  ])
  const out = {
    at: new Date().toISOString(),
    chainId: 56,
    factory: FACTORY,
    token,
    curve,
    launchTx: tx.hash,
    launchBlock: rc.blockNumber,
    buyTx: buy.hash,
    buyBlock: brc.blockNumber,
    spentBnb: '0.0002',
    tokensOut: bought.args.tokensOut.toString(),
    fee: bought.args.fee.toString(),
    snipeTax: bought.args.snipeTax.toString(),
    supply: supply.toString(),
    curveTokenBalance: curveBal.toString(),
    buyerTokenBalance: buyerBal.toString(),
    trackedQuote: trackedQuote.toString(),
    trackedTokens: trackedTokens.toString(),
    reservedTokens: reserved.toString(),
    deployerBeforeBnb: ethers.formatEther(before),
    deployerAfterBnb: ethers.formatEther(after),
    note: 'Public demo token launched through the live OAKEN Curve factory. Not an official project. Graduation not run.',
  }
  const file = path.join(__dirname, '..', '..', 'data', 'curve-live-demo-2026-10-25.json')
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  console.log(JSON.stringify(out, null, 2))
  console.log('report', file)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
