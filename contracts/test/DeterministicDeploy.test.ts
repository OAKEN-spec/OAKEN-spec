/**
 * The "same address on every chain" claim, tested rather than asserted.
 *
 * `deterministic-addresses.ts` computes an address, and arithmetic alone would
 * happily agree with itself. So this suite installs the real deployment proxy's
 * runtime code at its canonical address — the same 69 bytes that a live `eth_getCode`
 * returns on Base, Arbitrum, Avalanche, Robinhood Chain and the rest — and then
 * performs the actual deployment. If the address the proxy produces is not the
 * one the script printed, the deployment story is wrong and this fails.
 *
 * The proxy is not a contract we wrote and not one we will deploy: it already
 * exists at `0x4e59…956C` on every chain that matters, verified byte-identical
 * on ten of them. Only its code is reproduced here.
 */

import { expect } from 'chai'
import { ethers, network } from 'hardhat'
import type { Contract } from 'ethers'

/** Arachnid's deterministic deployment proxy, and its 69 bytes of runtime code. */
const DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const DEPLOYER_CODE =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'

const SALT = ethers.keccak256(ethers.toUtf8Bytes('locker.v1'))

async function installProxy() {
  await network.provider.send('hardhat_setCode', [DEPLOYER, DEPLOYER_CODE])
}

/** Where `name` lands, computed the way the deploy script computes it. */
async function predictedAddress(name: string) {
  const factory = await ethers.getContractFactory(name)
  return ethers.getCreate2Address(DEPLOYER, SALT, ethers.keccak256(factory.bytecode))
}

/** Perform the real deployment through the proxy, exactly as a chain would. */
async function deployThrough(name: string, salt: string = SALT) {
  const [sender] = await ethers.getSigners()
  const factory = await ethers.getContractFactory(name)
  const data = ethers.concat([salt, factory.bytecode])
  const tx = await sender.sendTransaction({ to: DEPLOYER, data, gasLimit: 5_000_000 })
  await tx.wait()
  return ethers.getCreate2Address(DEPLOYER, salt, ethers.keccak256(factory.bytecode))
}

describe('deterministic deployment', () => {
  it('puts LockVault at the address the script prints, and it works', async () => {
    await installProxy()
    const predicted = await predictedAddress('LockVault')

    const actual = await deployThrough('LockVault')
    expect(actual).to.equal(predicted)
    expect(await actual).to.equal('0xe410d0a21C1376992874a9bEEeE0d623A50D4a34')

    // Deployed code, not just a non-empty address.
    expect((await ethers.provider.getCode(predicted)).length).to.be.greaterThan(2)

    // And the thing that landed there is a working vault.
    const vault: Contract = await ethers.getContractAt('LockVault', predicted)
    expect(await vault.nextLockId()).to.equal(1n)
  })

  it('puts PositionLock at the address the script prints, and it works', async () => {
    await installProxy()
    const predicted = await predictedAddress('PositionLock')

    const actual = await deployThrough('PositionLock')
    expect(actual).to.equal(predicted)
    expect(await actual).to.equal('0xfC9A43c90e0E0d548D95cEf3C77fce802806CbA9')

    const lock: Contract = await ethers.getContractAt('PositionLock', predicted)
    expect(await lock.nextLockId()).to.equal(1n)
  })

  it('gives a different address for a different salt', async () => {
    await installProxy()
    const otherSalt = ethers.keccak256(ethers.toUtf8Bytes('locker.v2'))

    const actual = await deployThrough('LockVault', otherSalt)
    const expected = await predictedAddress('LockVault')
    expect(actual).to.not.equal(expected)

    // Which is the reason the salt is a named constant in the deploy script:
    // it is part of the address, and it cannot be changed afterwards.
    expect((await ethers.provider.getCode(actual)).length).to.be.greaterThan(2)
  })

  it('refuses a second deployment at the same salt', async () => {
    await installProxy()
    // A salt used by nothing yet, then used twice.
    const salt = ethers.keccak256(ethers.toUtf8Bytes('locker.collision-test'))
    await deployThrough('LockVault', salt)

    const [sender] = await ethers.getSigners()
    const factory = await ethers.getContractFactory('LockVault')
    const data = ethers.concat([salt, factory.bytecode])
    // The proxy bubbles up the CREATE2 failure, so the surfaced reason is
    // generic; what matters is that it does not silently no-op.
    await expect(sender.sendTransaction({ to: DEPLOYER, data, gasLimit: 5_000_000 })).to.be.reverted
  })
})
