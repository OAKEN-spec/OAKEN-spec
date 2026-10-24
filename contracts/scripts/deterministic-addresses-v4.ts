/**
 * Where the v4 upgradeable stack lands. Nothing is deployed by this script.
 *
 *   npm run addresses:v4
 *
 * v4 = v3 behind an ERC1967 proxy, with a 2-of-3 multisig and a 48h delayed
 * admin (see contracts/v4/README.md). The proxy addresses are what the site and
 * the indexer use; the implementation addresses are printed for verification.
 */
import { ethers } from 'hardhat'

const DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const SALT = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s))
const OWNERS = [
  '0x4b696e72369Af9AD6998BCb30C575191aAAB4c6d',
  '0x4b8b1C5AC996632BC71f20291665C975d47F66BA',
  '0x9127F7021315bdf6D43EF3916487Bcd7D93Cd901',
]
const THRESHOLD = 2
const DELAY = 172800

async function main() {
  const c2 = (salt: string, init: string) => ethers.getCreate2Address(DEPLOYER, salt, ethers.keccak256(init))
  const coder = ethers.AbiCoder.defaultAbiCoder()
  const bytes = (b: string) => (b.length - 2) / 2

  const multisigF = await ethers.getContractFactory('OakenMultisig')
  const multisigInit = ethers.concat([
    multisigF.bytecode,
    coder.encode(['address[]', 'uint256'], [OWNERS, THRESHOLD]),
  ])
  const multisig = c2(SALT('multisig.v4'), multisigInit)
  console.log(`OakenMultisig        ${multisig}   (${bytes(multisigF.bytecode)} B + owners & threshold)`)

  const adminF = await ethers.getContractFactory('DelayedProxyAdmin')
  const adminInit = ethers.concat([adminF.bytecode, coder.encode(['address', 'uint256'], [multisig, DELAY])])
  const admin = c2(SALT('proxyadmin.v4'), adminInit)
  console.log(`DelayedProxyAdmin    ${admin}   (${bytes(adminF.bytecode)} B + owner & delay)`)

  const proxyF = await ethers.getContractFactory('ERC1967Proxy')

  const vaultF = await ethers.getContractFactory('LockVaultV4')
  const vaultImpl = c2(SALT('vaultimpl.v4'), vaultF.bytecode)
  const vaultInit = ethers.concat([
    proxyF.bytecode,
    coder.encode(
      ['address', 'address', 'bytes'],
      [admin, vaultImpl, vaultF.interface.encodeFunctionData('initialize')],
    ),
  ])
  const vaultProxy = c2(SALT('vaultproxy.v4'), vaultInit)
  console.log(`LockVaultV4 impl     ${vaultImpl}   (${bytes(vaultF.bytecode)} B)`)
  console.log(`ERC1967Proxy(vault)  ${vaultProxy}   (${bytes(proxyF.bytecode)} B + admin & impl & initialize)`)

  const adapterF = await ethers.getContractFactory('PinkLockAdapterV4')
  const adapterImpl = c2(SALT('adapterimpl.v4'), adapterF.bytecode)
  const adapterInit = ethers.concat([
    proxyF.bytecode,
    coder.encode(
      ['address', 'address', 'bytes'],
      [admin, adapterImpl, adapterF.interface.encodeFunctionData('initialize', [vaultProxy])],
    ),
  ])
  const adapterProxy = c2(SALT('adapterproxy.v4'), adapterInit)
  console.log(`PinkLockAdapterV4    ${adapterImpl}   (${bytes(adapterF.bytecode)} B)`)
  console.log(`ERC1967Proxy(adapter) ${adapterProxy}   (${bytes(proxyF.bytecode)} B + admin & impl & initialize)`)

  const factoryF = await ethers.getContractFactory('TokenFactory')
  const tokenFactory = c2(SALT('tokenfactory.v1'), factoryF.bytecode)
  const launcherF = await ethers.getContractFactory('OakenLauncher')
  const launcherInit = ethers.concat([
    launcherF.bytecode,
    coder.encode(['address', 'address'], [tokenFactory, adapterProxy]),
  ])
  const launcher = c2(SALT('launcher.v4'), launcherInit)
  console.log(`OakenLauncherV4      ${launcher}   (${bytes(launcherF.bytecode)} B + factory & adapter)`)

  console.log(`\nowners: ${OWNERS.join(' ')}  threshold ${THRESHOLD}  delay ${DELAY}s`)
  console.log(`salts: multisig.v4 / proxyadmin.v4 / vaultimpl.v4 / vaultproxy.v4 / adapterimpl.v4 / adapterproxy.v4 / launcher.v4`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
