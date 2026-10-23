/**
 * Compute the address each contract will land on, on every chain.
 *
 * The Arachnid deterministic deployment proxy at
 * 0x4e59b44847b379578588920cA78FbF26c0B4956C is deployed at that address on
 * every chain that matters (verified on ten of them: the 69 bytes of code are
 * byte-identical, so the proxy address is not something we are hoping holds).
 * It deploys with CREATE2 over `salt || initCode`, which means the resulting
 * address is a pure function of the salt, the init code, and the proxy — none
 * of which is chain-specific. Sign the transaction once, replay it everywhere,
 * and the contract is at the same address.
 *
 * The catch, and the reason this script exists rather than a comment: the init
 * code includes the constructor arguments. A single constructor argument that
 * differs per chain — WETH, a multicall address, a chain id — would give a
 * different address per chain and quietly undo the whole thing. So this script
 * asserts that every contract has a zero-argument constructor and refuses to
 * print an address for one that does not.
 *
 * Run with `npm run addresses`.
 */

import { ethers } from 'hardhat'

/**
 * The deterministic deployment proxy. Neither contract is deployed *by* this
 * script; it only computes where they would land.
 */
const DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C'

/**
 * The salt is part of the address: changing it moves every contract on every
 * chain, and there is no way to move a contract after deployment. It has to be
 * chosen once, before the first chain, and then never touched — so it is a
 * named constant here rather than something a caller passes in.
 */
const SALT = ethers.keccak256(ethers.toUtf8Bytes('locker.v1'))

/**
 * The bridge gets its own salt: `locker.v1` already names an address that has
 * code on ten live chains, and the vault's address must never move.
 */
const SALT_ADAPTER = ethers.keccak256(ethers.toUtf8Bytes('adapter.v1'))

/**
 * 发射台（发币 + 锁仓一笔做完）也有自己的 salt。它的两个构造参数
 * （代币工厂、适配器）**跨链同址**，所以它自己也跨链同址 ——
 * 规则和适配器一样："初始化代码不能逐链不同"，不是"不许有参数"。
 */
const SALT_LAUNCHER = ethers.keccak256(ethers.toUtf8Bytes('launcher.v1'))

/**
 * The tool contracts, each with a salt that names **what it is** rather than
 * when it was deployed or what the brand is called this month.
 *
 * A salt is part of an address and cannot be changed afterwards, so the naming
 * rule matters as much as the value: `multisender.v1` describes the contract,
 * which means renaming the site does not move it, and shipping a different
 * MultiSender does.
 */
const TOOLS: { name: string; salt: string }[] = [
  { name: 'MultiSender', salt: 'multisender.v1' },
  { name: 'TokenFactory', salt: 'tokenfactory.v1' },
  { name: 'OakenAirdrop', salt: 'airdrop.v1' },
  { name: 'PresaleFactory', salt: 'presalefactory.v1' },
]

const CONTRACTS = ['LockVault', 'PositionLock'] as const

async function main() {
  console.log(`deterministic deployer  ${DEPLOYER}`)
  console.log(`salt                    ${SALT}`)
  console.log(`                        (keccak256("locker.v1"))`)
  console.log()

  const addresses: Record<string, string> = {}

  for (const name of CONTRACTS) {
    const factory = await ethers.getContractFactory(name)
    const initCode = factory.bytecode

    // A constructor argument would be appended to the init code, and an
    // argument that varies per chain would make the address vary per chain.
    const fragment = factory.interface.deploy
    const args = fragment?.inputs ?? []
    if (args.length !== 0) {
      throw new Error(
        `${name} has ${args.length} constructor argument(s). ` +
          'The same address on every chain requires zero, unless every chain ' +
          'passes identical bytes.'
      )
    }

    const address = ethers.getCreate2Address(DEPLOYER, SALT, ethers.keccak256(initCode))
    const bytes = (initCode.length - 2) / 2
    addresses[name] = address
    console.log(`${name.padEnd(16)} ${address}   (init code ${bytes} bytes)`)
  }

  /**
   * `PinkLockAdapter` is the one contract that may take a constructor
   * argument, because the argument is the vault's address — and that address
   * is the same on every chain by construction. The rule the check above
   * enforces is "the init code must not vary per chain", not "there must be no
   * arguments"; passing the constant this script just derived keeps it.
   */
  {
    const factory = await ethers.getContractFactory('PinkLockAdapter')
    const initCode = ethers.concat([
      factory.bytecode,
      ethers.AbiCoder.defaultAbiCoder().encode(['address'], [addresses.LockVault]),
    ])
    const address = ethers.getCreate2Address(DEPLOYER, SALT_ADAPTER, ethers.keccak256(initCode))
    addresses.PinkLockAdapter = address
    const bytes = (factory.bytecode.length - 2) / 2
    console.log(`${'PinkLockAdapter'.padEnd(16)} ${address}   (init code ${bytes} bytes + vault address)`)
  }

  /**
   * The four tools. Same rule as the vault: zero constructor arguments, so the
   * address is a pure function of (salt, init code) and lands identically on
   * every chain we deploy to.
   */
  console.log()
  for (const tool of TOOLS) {
    const factory = await ethers.getContractFactory(tool.name)
    const args = factory.interface.deploy?.inputs ?? []
    if (args.length !== 0) {
      throw new Error(`${tool.name} has ${args.length} constructor argument(s); tools must take none.`)
    }
    const salt = ethers.keccak256(ethers.toUtf8Bytes(tool.salt))
    const address = ethers.getCreate2Address(DEPLOYER, salt, ethers.keccak256(factory.bytecode))
    addresses[tool.name] = address
    const bytes = (factory.bytecode.length - 2) / 2
    console.log(`${tool.name.padEnd(16)} ${address}   (init code ${bytes} bytes · salt "${tool.salt}")`)
  }

  /**
   * `OakenLauncher`：发币 + 锁仓一笔做完。参数是**代币工厂**与**适配器** ——
   * 两个都跨链同址，所以它自己也跨链同址。放在最后是因为它依赖上面算出来的两个地址。
   */
  {
    const factory = await ethers.getContractFactory('OakenLauncher')
    const args = factory.interface.deploy?.inputs ?? []
    if (args.length !== 2) throw new Error(`OakenLauncher 期望两个构造参数，实际 ${args.length} 个`)
    const initCode = ethers.concat([
      factory.bytecode,
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'address'],
        [addresses.TokenFactory, addresses.PinkLockAdapter],
      ),
    ])
    const address = ethers.getCreate2Address(DEPLOYER, SALT_LAUNCHER, ethers.keccak256(initCode))
    addresses.OakenLauncher = address
    const bytes = (factory.bytecode.length - 2) / 2
    console.log(`${'OakenLauncher'.padEnd(16)} ${address}   (init code ${bytes} bytes + factory & adapter · salt "launcher.v1")`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
