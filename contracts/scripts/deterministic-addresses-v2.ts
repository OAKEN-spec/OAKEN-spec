/**
 * Where the v2 contracts would land. Nothing is deployed by this script.
 *
 *   npm run addresses:v2
 *
 * The salts are new on purpose: `locker.v1` and `adapter.v1` already name live
 * contracts whose addresses must never move. See contracts/V2.md.
 */
import { ethers } from 'hardhat'

const DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const SALT_VAULT = ethers.keccak256(ethers.toUtf8Bytes('locker.v2'))
const SALT_ADAPTER = ethers.keccak256(ethers.toUtf8Bytes('adapter.v2'))
const SALT_LAUNCHER = ethers.keccak256(ethers.toUtf8Bytes('launcher.v2'))

async function main() {
  const vaultF = await ethers.getContractFactory('LockVaultV2')
  const vault = ethers.getCreate2Address(DEPLOYER, SALT_VAULT, ethers.keccak256(vaultF.bytecode))
  console.log(`LockVaultV2          ${vault}   (init code ${(vaultF.bytecode.length - 2) / 2} bytes)`)

  const adapterF = await ethers.getContractFactory('PinkLockAdapterV2')
  const init = ethers.concat([
    adapterF.bytecode,
    ethers.AbiCoder.defaultAbiCoder().encode(['address'], [vault]),
  ])
  const adapter = ethers.getCreate2Address(DEPLOYER, SALT_ADAPTER, ethers.keccak256(init))
  console.log(`PinkLockAdapterV2    ${adapter}   (init code ${(adapterF.bytecode.length - 2) / 2} bytes + vault address)`)

  /**
   * The launcher is the v1 source unchanged, with the v2 adapter as its second
   * constructor argument. Its address therefore depends on the unchanged
   * TokenFactory (same `tokenfactory.v1` salt and bytecode) plus `adapter.v2`.
   */
  const factoryF = await ethers.getContractFactory('TokenFactory')
  const tokenFactory = ethers.getCreate2Address(
    DEPLOYER,
    ethers.keccak256(ethers.toUtf8Bytes('tokenfactory.v1')),
    ethers.keccak256(factoryF.bytecode),
  )
  const launcherF = await ethers.getContractFactory('OakenLauncher')
  const launcherInit = ethers.concat([
    launcherF.bytecode,
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address'], [tokenFactory, adapter]),
  ])
  const launcher = ethers.getCreate2Address(DEPLOYER, SALT_LAUNCHER, ethers.keccak256(launcherInit))
  console.log(`OakenLauncherV2      ${launcher}   (init code ${(launcherF.bytecode.length - 2) / 2} bytes + factory & adapter)`)

  console.log(`\nsalts: locker.v2=${SALT_VAULT}`)
  console.log(`       adapter.v2=${SALT_ADAPTER}`)
  console.log(`       launcher.v2=${SALT_LAUNCHER}`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
