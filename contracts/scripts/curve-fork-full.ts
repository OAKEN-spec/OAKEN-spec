/**
 * Full fork E2E for the 4663 Pons-model launch:
 * factory → token + curve → buys to the graduation line → graduate → real V4
 * position held by the graduator.
 *
 *   npx hardhat run scripts/curve-fork-full.ts --network hardhat
 *
 * Judgement is the ERC-721 Transfer and ownerOf from the live PositionManager,
 * not our own events: if the position is owned by the graduator, the whole
 * path (factory call, curve accounting, Permit2 approvals, native settlement,
 * hook) actually ran on 4663's real V4.
 */
import { ethers, network } from 'hardhat'

const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951'
const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const RPC = process.env.FORK_RPC || 'https://rpc.mainnet.chain.robinhood.com'

const SUPPLY = ethers.parseEther('1000000000')
const PHANTOM = ethers.parseEther('1.68')
const THRESHOLD = ethers.parseEther('4.2')
const RESERVED = (SUPPLY * PHANTOM) / (PHANTOM + THRESHOLD)
const SQRT_LOWER = 4310618291n
const SQRT_UPPER = 1456195216270955103182949462556801019286893565306n

async function main() {
  console.log('forking', RPC, '…')
  await network.provider.request({ method: 'hardhat_reset', params: [{ forking: { jsonRpcUrl: RPC } }] })
  const [deployer, protocol, creator, buyer] = await ethers.getSigners()
  for (const s of [deployer, creator, buyer]) {
    await network.provider.send('hardhat_setBalance', [s.address, '0x56BC75E2D63100000'])
  }

  console.log('deploying the mined graduator …')
  const deployerContract: any = await ethers.deployContract('CurveDeployer')
  const gradFactory = await ethers.getContractFactory('OakenCurveGraduatorV4')
  const argData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'address', 'address', 'uint24', 'int24', 'uint160', 'uint160'],
    [deployer.address, POOL_MANAGER, POSITION_MANAGER, PERMIT2, 0, 200, SQRT_LOWER, SQRT_UPPER],
  )
  const initCode = ethers.concat([gradFactory.bytecode, argData])
  const initHash = ethers.keccak256(initCode)
  let salt = ethers.ZeroHash
  let gradAddr = ethers.ZeroAddress
  for (let i = 0; i < 3_000_000; i++) {
    salt = ethers.hexlify(ethers.randomBytes(32))
    gradAddr = ethers.getCreate2Address(deployerContract.target, salt, initHash)
    if ((BigInt(gradAddr) & 0x3fffn) === 0x2800n) break
  }
  if ((BigInt(gradAddr) & 0x3fffn) !== 0x2800n) throw new Error('hook address mining failed')
  await (await deployerContract.deploy(salt, initCode)).wait()
  const graduator: any = await ethers.getContractAt('OakenCurveGraduatorV4', gradAddr)

  console.log('deploying the factory …')
  const factory: any = await ethers.deployContract('OakenCurveFactory', [[
    SUPPLY, 0n, PHANTOM, THRESHOLD,
    100n, // curve fee 1%
    1000n, // max creator tax 10%
    0n, // protocol share
    9900n, // snipe start
    3n, // snipe seconds
    protocol.address,
    graduator.target,
    protocol.address,
    0n, // launch fee
  ]])
  await (await graduator.connect(deployer).bindFactory(factory.target)).wait()

  console.log('creating a launch through the factory …')
  const launchSalt = ethers.hexlify(ethers.randomBytes(32))
  const launchTx = await factory.connect(creator).createLaunch({
    name: 'Fork Curve Launch',
    symbol: 'FCL',
    creatorFeeRecipient: creator.address,
    creatorTaxBps: 0,
    salt: launchSalt,
    snipeTaxExempt: [],
  })
  const launchRc = await launchTx.wait()
  const ev = launchRc!.logs
    .map((l: any) => { try { return factory.interface.parseLog(l) } catch { return null } })
    .find((e: any) => e?.name === 'LaunchCreated')
  if (!ev) throw new Error('no LaunchCreated event')
  const token: any = await ethers.getContractAt('OakenToken', ev.args.token)
  const curve: any = await ethers.getContractAt('OakenCurve', ev.args.curve)
  console.log('  token  =', token.target)
  console.log('  curve  =', curve.target)
  console.log('  supply in curve =', (await token.balanceOf(curve.target)).toString())
  console.log('  creator balance =', (await token.balanceOf(creator.address)).toString())

  console.log('partial buy + sell (checks the real/virtual reserve split) …')
  await (await curve.connect(creator).buy(0, creator.address, { value: ethers.parseEther('1') })).wait()
  const held = await token.balanceOf(creator.address)
  const half = held / 2n
  await (await token.connect(creator).approve(curve.target, half)).wait()
  const beforeSell = await curve.trackedTokens()
  await (await curve.connect(creator).sell(half, 0, creator.address)).wait()
  const afterSell = await curve.trackedTokens()
  if (afterSell !== beforeSell + half) throw new Error('sell did not grow the real reserve by exactly the tokens in')
  if ((await token.balanceOf(curve.target)) !== afterSell) throw new Error('curve token balance != tracked reserve')
  console.log('  tracked tokens after sell =', afterSell.toString())

  console.log('buying to the graduation line …')
  const buyTx = await curve.connect(creator).buy(0, creator.address, { value: ethers.parseEther('5') })
  const buyRc = await buyTx.wait()
  const bought = buyRc!.logs
    .map((l: any) => { try { return curve.interface.parseLog(l) } catch { return null } })
    .find((e: any) => e?.name === 'Bought')
  console.log('  spent (net of refund) =', bought.args.quoteIn.toString())
  console.log('  tokens out            =', bought.args.tokensOut.toString())
  console.log('  ready to graduate     =', await curve.readyToGraduate())
  console.log('  tracked tokens        =', (await curve.trackedTokens()).toString())
  if (!(await curve.readyToGraduate())) throw new Error('curve did not reach graduation')

  console.log('graduating …')
  const gradTx = await curve.connect(buyer).graduate()
  await gradTx.wait()
  const posm: any = await ethers.getContractAt(
    ['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
     'function ownerOf(uint256) view returns (address)'],
    POSITION_MANAGER,
  )
  const transfer = (await gradTx.wait())!.logs
    .map((l: any) => { try { return posm.interface.parseLog(l) } catch { return null } })
    .find((e: any) => e?.name === 'Transfer' && e.args.to.toLowerCase() === graduator.target.toLowerCase())
  if (!transfer) throw new Error('no position NFT minted to the graduator')
  const owner = await posm.ownerOf(transfer.args.tokenId)
  console.log('  position id    =', transfer.args.tokenId.toString())
  console.log('  position owner =', owner)
  console.log('  curve graduated =', await curve.graduated())
  console.log('  curve token bal =', (await token.balanceOf(curve.target)).toString())
  console.log('  graduator token =', (await token.balanceOf(graduator.target)).toString())
  if (owner.toLowerCase() !== graduator.target.toLowerCase()) throw new Error('position not held by graduator')

  console.log('\n✅ full fork E2E passed — factory, curve, graduation and real V4 position')
}

main().catch((e) => {
  console.error('❌ full fork E2E failed:', e)
  process.exit(1)
})
