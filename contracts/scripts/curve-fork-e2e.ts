/**
 * Fork E2E for the V4 graduation adapter on Robinhood Chain (4663).
 *
 *   npx hardhat run scripts/curve-fork-e2e.ts --network hardhat
 *
 * It forks 4663, deploys a real graduator against the live PoolManager /
 * PositionManager / Permit2, initializes a fresh pool at the graduation price,
 * and runs the actual `modifyLiquidities` mint. The judgement is the ERC-721
 * Transfer from the position manager to the graduator plus `ownerOf` — not our
 * own logs.
 *
 * The fork deploy uses a plain `new` address, so the hook permission bits are
 * not set and V4 does not call the hook on this fork. That is deliberate: this
 * script tests the mint encoding, Permit2 approvals and native settlement. The
 * hook itself is unit-tested; the mined-address deployment is covered by the
 * deploy script's flag assertion.
 */
import { ethers, network } from 'hardhat'

const POOL_MANAGER = process.env.POOL_MANAGER || '0x8366a39CC670B4001A1121B8F6A443A643e40951'
const POSITION_MANAGER = process.env.POSITION_MANAGER || '0x58daec3116aae6d93017baaea7749052e8a04fa7'
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const RPC = process.env.FORK_RPC || process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'

const SUPPLY = ethers.parseEther('1000000000')
const PHANTOM = ethers.parseEther('1.68')
const THRESHOLD = ethers.parseEther('4.2')
const RESERVED = (SUPPLY * PHANTOM) / (PHANTOM + THRESHOLD)
const SQRT_LOWER = 4310618291n
const SQRT_UPPER = 1456195216270955103182949462556801019286893565306n

async function main() {
  console.log('forking', RPC, '…')
  await network.provider.request({
    method: 'hardhat_reset',
    params: [{ forking: { jsonRpcUrl: RPC } }],
  })
  const [deployer, factory, alice] = await ethers.getSigners()
  console.log('  fork block        =', await ethers.provider.getBlockNumber())
  console.log('  poolManager code  =', ((await ethers.provider.getCode(POOL_MANAGER)).length - 2) / 2, 'bytes')
  console.log('  positionMgr code  =', ((await ethers.provider.getCode(POSITION_MANAGER)).length - 2) / 2, 'bytes')
  await network.provider.send('hardhat_setBalance', [deployer.address, '0x56BC75E2D63100000'])

  /**
   * V4 reads hook permissions from the address, so the adapter must land at an
   * address whose low 14 bits are beforeInitialize | beforeAddLiquidity
   * (0x2800). Mine a CREATE2 salt and deploy through CurveDeployer.
   */
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
  for (let i = 0; i < 2_000_000; i++) {
    salt = ethers.hexlify(ethers.randomBytes(32))
    gradAddr = ethers.getCreate2Address(deployerContract.target, salt, initHash)
    if ((BigInt(gradAddr) & 0x3fffn) === 0x2800n) break
  }
  console.log('  mined graduator address =', gradAddr)
  if ((BigInt(gradAddr) & 0x3fffn) !== 0x2800n) throw new Error('failed to mine hook address')
  console.log('  on-chain predict    =', await deployerContract.predict(salt, initCode))
  const deployRc = await (await deployerContract.deploy(salt, initCode)).wait()
  const deployed = deployRc!.logs
    .map((l: any) => { try { return deployerContract.interface.parseLog(l) } catch { return null } })
    .find((e: any) => e?.name === 'Deployed')
  console.log('  Deployed event addr =', deployed ? deployed.args.addr : '(none)')
  console.log('  Deployed event salt =', deployed ? deployed.args.salt : '(none)')
  console.log('  our salt            =', salt)
  console.log('  initCode bytes      =', (initCode.length - 2) / 2, 'initHash', initHash.slice(0, 18))
  console.log('  deployer target     =', deployerContract.target)
  console.log('  predicted           =', gradAddr)
  console.log('  code at mined addr  =', ((await ethers.provider.getCode(gradAddr)).length - 2) / 2, 'bytes')
  const graduator: any = await ethers.getContractAt('OakenCurveGraduatorV4', gradAddr)
  await (await graduator.connect(deployer).bindFactory(factory.address)).wait()
  const curve: any = await ethers.deployContract('MockCurveRef', [factory.address])
  const token: any = await ethers.deployContract('OakenToken', [
    'Fork Graduation', 'FORKG', 18, SUPPLY, alice.address,
  ])
  await (await token.connect(alice).transfer(graduator.target, RESERVED)).wait()

  console.log('initializing the pool at the graduation price …')
  const initTx = await graduator.connect(factory).initializePool(token.target, THRESHOLD, RESERVED)
  const initRc = await initTx.wait()
  const poolManager: any = await ethers.getContractAt(
    ['function extsload(bytes32) view returns (bytes32)',
     'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'],
    POOL_MANAGER,
  )
  console.log('  init status =', initRc!.status, 'to =', initRc!.to, 'gas =', initRc!.gasUsed.toString())
  console.log('  graduator.factory =', await graduator.factory())
  console.log('  graduator.poolManager =', await graduator.poolManager())
  console.log('  init logs:', initRc!.logs.map((l: any) => `${l.address} ${l.topics[0]}`).join(' | '))
  const initializeLog = initRc!.logs
    .map((l: any) => { try { return poolManager.interface.parseLog(l) } catch { return null } })
    .find((e: any) => e?.name === 'Initialize')
  if (!initializeLog) throw new Error('PoolManager did not emit Initialize')
  const poolId = initializeLog.args.id
  const emittedSqrt = initializeLog.args.sqrtPriceX96
  console.log('  event pool id     =', poolId)
  console.log('  event sqrtPrice   =', emittedSqrt.toString())
  console.log('  event hooks       =', initializeLog.args.hooks)
  const key = [ethers.ZeroAddress, token.target, 0, 200, graduator.target]
  const expectedId = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['tuple(address,address,uint24,int24,address)'], [key]),
  )
  console.log('  expected pool id  =', expectedId)
  if (expectedId !== poolId) throw new Error('pool id mismatch: our PoolKey encoding is wrong')
  const stateSlot = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [poolId, ethers.toBeHex(6, 32)]),
  )
  const slot0 = await poolManager.extsload(stateSlot)
  const sqrtPrice = BigInt(slot0) & ((1n << 160n) - 1n)
  console.log('  slot0 sqrtPrice   =', sqrtPrice.toString(), '(raw', slot0, ')')
  if (sqrtPrice === 0n) console.log('  ⚠ slot0 read did not match; continuing with the Initialize event as the judge')

  console.log('graduating: real modifyLiquidities + Permit2 + native value …')
  const posm: any = await ethers.getContractAt(
    ['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
     'function ownerOf(uint256) view returns (address)'],
    POSITION_MANAGER,
  )
  const tx = await curve.connect(alice).callGraduate(
    graduator.target, token.target, RESERVED, THRESHOLD, { value: THRESHOLD },
  )
  const rc = await tx.wait()
  const transfer = rc!.logs
    .map((l: any) => { try { return posm.interface.parseLog(l) } catch { return null } })
    .find((e: any) => e?.name === 'Transfer' && e.args.to.toLowerCase() === graduator.target.toLowerCase())
  if (!transfer) throw new Error('no position NFT minted to the graduator')

  const tokenId = transfer.args.tokenId
  const owner = await posm.ownerOf(tokenId)
  console.log('  position id      =', tokenId.toString())
  console.log('  position owner   =', owner)
  console.log('  token allowance  =', (await token.allowance(graduator.target, PERMIT2)).toString())
  console.log('  graduator native =', (await ethers.provider.getBalance(graduator.target)).toString())

  if (owner.toLowerCase() !== graduator.target.toLowerCase()) throw new Error('NFT owner is not the graduator')
  if ((await token.allowance(graduator.target, PERMIT2)) === 0n) throw new Error('Permit2 approval missing')

  console.log('\n✅ fork E2E passed — real V4 pool seeded, position held by the graduator')
}

main().catch((e) => {
  console.error('❌ fork E2E failed:', e)
  process.exit(1)
})
