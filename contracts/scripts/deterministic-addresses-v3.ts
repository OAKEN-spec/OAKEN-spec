/**
 * Where the v3 contracts land. Nothing is deployed by this script.
 *
 *   npm run addresses:v3
 *
 * V3 is V2 plus the `revoke` clamp (see contracts/v3/README.md). The salts are
 * new on purpose: `locker.v1`/`locker.v2` and their adapters name live contracts
 * whose addresses must never move.
 */
import { ethers } from 'hardhat'

const DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const SALT_VAULT = ethers.keccak256(ethers.toUtf8Bytes('locker.v3'))
const SALT_ADAPTER = ethers.keccak256(ethers.toUtf8Bytes('adapter.v3'))
const SALT_LAUNCHER = ethers.keccak256(ethers.toUtf8Bytes('launcher.v3'))

async function main() {
  const vaultF = await ethers.getContractFactory('LockVaultV3')
  const vault = ethers.getCreate2Address(DEPLOYER, SALT_VAULT, ethers.keccak256(vaultF.bytecode))
  console.log(`LockVaultV3          ${vault}   (init code ${(vaultF.bytecode.length - 2) / 2} bytes)`)

  const adapterF = await ethers.getContractFactory('PinkLockAdapterV3')
  const init = ethers.concat([
    adapterF.bytecode,
    ethers.AbiCoder.defaultAbiCoder().encode(['address'], [vault]),
  ])
  const adapter = ethers.getCreate2Address(DEPLOYER, SALT_ADAPTER, ethers.keccak256(init))
  console.log(`PinkLockAdapterV3    ${adapter}   (init code ${(adapterF.bytecode.length - 2) / 2} bytes + vault address)`)

  /** Same v1 launcher source, constructor arg = the v3 adapter. */
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
  console.log(`OakenLauncherV3      ${launcher}   (init code ${(launcherF.bytecode.length - 2) / 2} bytes + factory & adapter)`)

  console.log(`\nsalts: locker.v3=${SALT_VAULT}`)
  console.log(`       adapter.v3=${SALT_ADAPTER}`)
  console.log(`       launcher.v3=${SALT_LAUNCHER}`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
