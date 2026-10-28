/**
 * Deploy the OAKEN Curve v5 stack.
 *
 *   CHAIN=4663 npx hardhat run scripts/deploy-curve.ts --network robinhood
 *   CHAIN=56   npx hardhat run scripts/deploy-curve.ts --network bsc
 *   … set EXECUTE=1 (or pass --execute to a plain node run) to actually send. Without it this is a dry run: it mines
 *     the V4 hook salt and prints every address and term, but sends nothing.
 *
 * 4663 deploys: CurveDeployer → mined OakenCurveGraduatorV4 → OakenCurveFactory → bind.
 * 56 deploys:   OakenFlapTokenDeployer → V2/V3 graduators → OakenFlapCurveFactory → bind.
 *
 * The V4 adapter must land at an address whose low 14 bits are 0x2800
 * (beforeInitialize | beforeAddLiquidity). The salt is mined against the
 * CurveDeployer's address; on execute we deploy the helper first and mine
 * against its real address, then assert the resulting flags.
 */
import { ethers, network } from 'hardhat'
import { getCreateAddress, getCreate2Address } from 'ethers'

const EXECUTE = process.env.EXECUTE === '1' || process.argv.includes('--execute')
const CHAIN = process.env.CHAIN || (network.name === 'bsc' ? '56' : '4663')

const SUPPLY = ethers.parseEther('1000000000')
const SQRT_LOWER = 4310618291n
const SQRT_UPPER = 1456195216270955103182949462556801019286893565306n

const V4 = {
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
}
const PANCAKE = {
  v2Router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  v3PositionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
  wbnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
}
const FLAP = {
  virtualTokens: ethers.parseEther('107036752'),
  phantomQuote: ethers.parseEther('6.14'),
  graduationThreshold: ethers.parseEther('16'),
}

function env(name: string, fallback: string): string {
  return process.env[name] || fallback
}

async function mineHookSalt(deployerAddr: string, initCode: string) {
  const hash = ethers.keccak256(initCode)
  let salt = ethers.ZeroHash
  let addr = ethers.ZeroAddress
  for (let i = 0; i < 5_000_000; i++) {
    salt = ethers.hexlify(ethers.randomBytes(32))
    addr = getCreate2Address(deployerAddr, salt, hash)
    if ((BigInt(addr) & 0x3fffn) === 0x2800n) break
  }
  if ((BigInt(addr) & 0x3fffn) !== 0x2800n) throw new Error('hook salt mining failed')
  return { salt, addr, hash }
}

async function deploy4663(deployer: any) {
  const protocolFeeRecipient = env('PROTOCOL_FEE_RECIPIENT', deployer.address)
  const launchFeeRecipient = env('LAUNCH_FEE_RECIPIENT', deployer.address)
  const protocolShareBps = BigInt(env('PROTOCOL_SHARE_BPS', '0'))
  const launchFee = ethers.parseEther(env('LAUNCH_FEE_ETH', '0'))
  const maxCreatorTaxBps = BigInt(env('MAX_CREATOR_TAX_BPS', '1000'))

  const gradFactory = await ethers.getContractFactory('OakenCurveGraduatorV4')
  const argData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'address', 'address', 'uint24', 'int24', 'uint160', 'uint160'],
    [deployer.address, V4.poolManager, V4.positionManager, V4.permit2, 0, 200, SQRT_LOWER, SQRT_UPPER],
  )
  const initCode = ethers.concat([gradFactory.bytecode, argData])

  const nonce = await ethers.provider.getTransactionCount(deployer.address)
  const predictedDeployer = getCreateAddress({ from: deployer.address, nonce })
  const mined = await mineHookSalt(predictedDeployer, initCode)
  console.log('predicted CurveDeployer   ', predictedDeployer)
  console.log('mined hook salt / address ', mined.salt, mined.addr)

  if (!EXECUTE) {
    console.log('\ndry run — config:')
    console.log({
      supply: SUPPLY.toString(), virtualTokens: '0',
      phantomQuote: ethers.parseEther('1.68').toString(),
      graduationThreshold: ethers.parseEther('4.2').toString(),
      feeBps: 100, maxCreatorTaxBps: maxCreatorTaxBps.toString(),
      protocolShareBps: protocolShareBps.toString(),
      snipeTaxStartBps: 9900, snipeTaxSeconds: 3,
      protocolFeeRecipient, launchFeeRecipient, launchFee: launchFee.toString(),
    })
    return
  }

  const helper = await ethers.deployContract('CurveDeployer')
  await helper.waitForDeployment()
  if (helper.target !== predictedDeployer) throw new Error('CurveDeployer address changed; rerun the dry run')
  const minedReal = await mineHookSalt(helper.target as string, initCode)
  const tx = await helper.deploy(minedReal.salt, initCode)
  await tx.wait()
  const graduator = await ethers.getContractAt('OakenCurveGraduatorV4', minedReal.addr)
  if ((BigInt(graduator.target as string) & 0x3fffn) !== 0x2800n) throw new Error('deployed hook flags wrong')

  const factory = await ethers.deployContract('OakenCurveFactory', [[
    SUPPLY, 0n, ethers.parseEther('1.68'), ethers.parseEther('4.2'),
    100n, maxCreatorTaxBps, protocolShareBps, 9900n, 3n,
    protocolFeeRecipient, graduator.target, launchFeeRecipient, launchFee,
  ]])
  await factory.waitForDeployment()
  await (await graduator.bindFactory(factory.target)).wait()

  console.log('\nOakenCurveGraduatorV4', graduator.target)
  console.log('OakenCurveFactory    ', factory.target)
}

async function deploy56(deployer: any) {
  const protocolFeeRecipient = env('PROTOCOL_FEE_RECIPIENT', deployer.address)
  const launchFeeRecipient = env('LAUNCH_FEE_RECIPIENT', deployer.address)
  const protocolShareBps = BigInt(env('PROTOCOL_SHARE_BPS', '600'))
  const launchFee = ethers.parseEther(env('LAUNCH_FEE_BNB', '0'))
  const maxCreatorTaxBps = BigInt(env('MAX_CREATOR_TAX_BPS', '1000'))

  if (!EXECUTE) {
    console.log('dry run — 56 config:')
    console.log({
      supply: SUPPLY.toString(), virtualTokens: FLAP.virtualTokens.toString(),
      phantomQuote: FLAP.phantomQuote.toString(), graduationThreshold: FLAP.graduationThreshold.toString(),
      feeBps: 100, protocolShareBps: protocolShareBps.toString(),
      maxCreatorTaxBps: maxCreatorTaxBps.toString(),
      snipeTaxStartBps: 9900, snipeTaxSeconds: 3,
      protocolFeeRecipient, launchFeeRecipient, launchFee: launchFee.toString(),
      v2Router: PANCAKE.v2Router, v3PositionManager: PANCAKE.v3PositionManager, wbnb: PANCAKE.wbnb,
    })
    return
  }

  const tokenDeployer = await ethers.deployContract('OakenFlapTokenDeployer', [deployer.address])
  await tokenDeployer.waitForDeployment()
  const taxGrad = await ethers.deployContract('OakenFlapGraduatorV2', [
    deployer.address, PANCAKE.v2Router, PANCAKE.wbnb,
  ])
  await taxGrad.waitForDeployment()
  const stdGrad = await ethers.deployContract('OakenFlapGraduatorV3', [
    deployer.address, PANCAKE.v3PositionManager, PANCAKE.wbnb, 2500, 50,
  ])
  await stdGrad.waitForDeployment()
  const factory = await ethers.deployContract('OakenFlapCurveFactory', [[
    SUPPLY, FLAP.virtualTokens, FLAP.phantomQuote, FLAP.graduationThreshold,
    100n, maxCreatorTaxBps, protocolShareBps, 9900n, 3n,
    protocolFeeRecipient, stdGrad.target, taxGrad.target, tokenDeployer.target,
    launchFeeRecipient, launchFee,
  ]])
  await factory.waitForDeployment()
  await (await tokenDeployer.bindFactory(factory.target)).wait()
  await (await stdGrad.bindFactory(factory.target)).wait()
  await (await taxGrad.bindFactory(factory.target)).wait()

  console.log('\nOakenFlapTokenDeployer ', tokenDeployer.target)
  console.log('OakenFlapGraduatorV2   ', taxGrad.target)
  console.log('OakenFlapGraduatorV3   ', stdGrad.target)
  console.log('OakenFlapCurveFactory  ', factory.target)
}

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('chain =', CHAIN, ' deployer =', deployer.address, ' execute =', EXECUTE)
  if (CHAIN === '56') await deploy56(deployer)
  else await deploy4663(deployer)
  if (!EXECUTE) console.log('\n(nothing was sent; add --execute)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
