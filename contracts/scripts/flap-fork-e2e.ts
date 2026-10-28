/**
 * BNB Chain (56) fork E2E for the Flap-model factory:
 * standard launch → Pancake V3 position; tax launch → Pancake V2 pair.
 *
 *   npx hardhat run scripts/flap-fork-e2e.ts --network hardhat
 *
 * Judgement is the live DEX state: the V3 position NFT's owner, and the V2
 * pair's LP balance held by the graduator plus the token's pool registry.
 */
import { ethers, network } from 'hardhat'

const RPC = process.env.FORK_RPC || 'https://bsc-rpc.publicnode.com'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const PANCAKE_V2_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E'
const PANCAKE_V3_NPM = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'
const PANCAKE_V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'

const SUPPLY = ethers.parseEther('1000000000')
const H = ethers.parseEther('107036752')
const R = ethers.parseEther('6.14')
const THRESHOLD = ethers.parseEther('16')

async function main() {
  console.log('forking BSC …')
  await network.provider.request({ method: 'hardhat_reset', params: [{ forking: { jsonRpcUrl: RPC } }] })
  const [deployer, protocol, creator, buyer] = await ethers.getSigners()
  for (const s of [deployer, creator, buyer]) {
    await network.provider.send('hardhat_setBalance', [s.address, '0x56BC75E2D63100000'])
  }

  const tokenDeployer: any = await ethers.deployContract('OakenFlapTokenDeployer', [deployer.address])
  const stdGrad: any = await ethers.deployContract('OakenFlapGraduatorV3', [
    deployer.address, PANCAKE_V3_NPM, WBNB, 2500, 50,
  ])
  const taxGrad: any = await ethers.deployContract('OakenFlapGraduatorV2', [
    deployer.address, PANCAKE_V2_ROUTER, WBNB,
  ])
  const factory: any = await ethers.deployContract('OakenFlapCurveFactory', [[
    SUPPLY, H, R, THRESHOLD,
    100n, 1000n, 600n, 9900n, 3n,
    protocol.address, stdGrad.target, taxGrad.target, tokenDeployer.target, protocol.address, 0n,
  ]])
  await (await tokenDeployer.connect(deployer).bindFactory(factory.target)).wait()
  await (await stdGrad.connect(deployer).bindFactory(factory.target)).wait()
  await (await taxGrad.connect(deployer).bindFactory(factory.target)).wait()
  console.log('factory =', factory.target)

  // ── standard launch → Pancake V3 ────────────────────────────────────────
  const stdSalt = ethers.hexlify(ethers.randomBytes(32))
  const stdTx = await factory.connect(creator).createLaunch([
    'Fork Standard', 'FSTD', creator.address, 0, stdSalt, [], false,
    [0, 0, 0, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress],
  ])
  const stdEv = (await stdTx.wait())!.logs
    .map((l: any) => { try { return factory.interface.parseLog(l) } catch { return null } })
    .find((e: any) => e?.name === 'LaunchCreated')
  const stdToken: any = await ethers.getContractAt('OakenToken', stdEv.args.token)
  const stdCurve: any = await ethers.getContractAt('OakenCurve', stdEv.args.curve)
  console.log('standard token =', stdToken.target, 'curve =', stdCurve.target)

  await (await stdCurve.connect(creator).buy(0, creator.address, { value: ethers.parseEther('1') })).wait()
  const held = await stdToken.balanceOf(creator.address)
  const half = held / 2n
  await (await stdToken.connect(creator).approve(stdCurve.target, half)).wait()
  const beforeSell = await stdCurve.trackedTokens()
  await (await stdCurve.connect(creator).sell(half, 0, creator.address)).wait()
  const afterSell = await stdCurve.trackedTokens()
  if (afterSell !== beforeSell + half) throw new Error('sell inflated the real reserve')
  if ((await stdToken.balanceOf(stdCurve.target)) !== afterSell) throw new Error('curve token balance != tracked reserve')
  console.log('  tracked tokens after sell =', afterSell.toString())

  await (await stdCurve.connect(creator).buy(0, creator.address, { value: ethers.parseEther('20') })).wait()
  console.log('  ready to graduate =', await stdCurve.readyToGraduate())
  let stdRc: any
  try {
    const stdGradTx = await stdCurve.connect(buyer).graduate()
    stdRc = await stdGradTx.wait()
  } catch (e: any) {
    console.error('graduate error reason =', e.shortMessage || e.reason || e.message)
    console.error('graduate error data   =', e.data || (e.info && e.info.error && e.info.error.data))
    console.error('graduate error info   =', JSON.stringify(e.info || {}).slice(0, 600))
    throw e
  }
  const npm: any = await ethers.getContractAt(
    ['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
     'function ownerOf(uint256) view returns (address)'],
    PANCAKE_V3_NPM,
  )
  const nft = stdRc!.logs
    .map((l: any) => { try { return npm.interface.parseLog(l) } catch { return null } })
    .find((e: any) => e?.name === 'Transfer' && e.args.to.toLowerCase() === stdGrad.target.toLowerCase())
  if (!nft) throw new Error('no Pancake V3 position minted to the graduator')
  console.log('  V3 position id =', nft.args.tokenId.toString(), 'owner =', await npm.ownerOf(nft.args.tokenId))

  // ── tax launch → Pancake V2 ─────────────────────────────────────────────
  const taxSalt = ethers.hexlify(ethers.randomBytes(32))
  const taxTx = await factory.connect(creator).createLaunch([
    'Fork Tax', 'FTAX', creator.address, 0, taxSalt, [], true,
    [500, 500, 3600, 4000, 2000, 2000, 2000, creator.address, creator.address, creator.address],
  ])
  const taxEv = (await taxTx.wait())!.logs
    .map((l: any) => { try { return factory.interface.parseLog(l) } catch { return null } })
    .find((e: any) => e?.name === 'LaunchCreated')
  const taxToken: any = await ethers.getContractAt('OakenTaxToken', taxEv.args.token)
  const taxCurve: any = await ethers.getContractAt('OakenCurve', taxEv.args.curve)
  console.log('tax token =', taxToken.target, 'curve =', taxCurve.target)

  await (await taxCurve.connect(creator).buy(0, creator.address, { value: ethers.parseEther('20') })).wait()
  console.log('  ready to graduate =', await taxCurve.readyToGraduate())
  await (await taxCurve.connect(buyer).graduate()).wait()

  const pairFactory: any = await ethers.getContractAt(
    ['function getPair(address,address) view returns (address)'], PANCAKE_V2_FACTORY,
  )
  const pair = await pairFactory.getPair(taxToken.target, WBNB)
  if (pair === ethers.ZeroAddress) throw new Error('Pancake V2 pair was not created')
  const lp: any = await ethers.getContractAt(
    ['function balanceOf(address) view returns (uint256)'], pair,
  )
  const lpBal = await lp.balanceOf(taxGrad.target)
  console.log('  pair =', pair, 'LP held by graduator =', lpBal.toString())
  console.log('  token.isPool(pair) =', await taxToken.isPool(pair), 'taxActive =', await taxToken.taxActive())
  if (lpBal === 0n) throw new Error('graduator holds no LP tokens')
  if (!(await taxToken.isPool(pair))) throw new Error('pair was not registered in the token')

  console.log('\n✅ BSC fork E2E passed — V3 position and V2 pair both seeded and held by the graduators')
}

main().catch((e) => {
  console.error('❌ BSC fork E2E failed:', e)
  process.exit(1)
})
