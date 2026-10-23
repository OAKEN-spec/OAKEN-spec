import { expect } from 'chai'
import { ethers } from 'hardhat'
import { latest, jumpTo, as } from './helpers'
import type { Contract } from 'ethers'

/**
 * v2 — the deployed production path since 2026-10-23.
 *
 * v2 is v1 plus two fixes (reentrancy guard, ETH refund). These tests exist so
 * the Hardhat suite — and therefore the coverage report — actually executes the
 * contracts every new lock goes through. The Foundry suites
 * (`V2Fixes.t.sol`, `ReentrancyPoC.t.sol`) remain the adversarial proof; this
 * is the everyday-path regression.
 */
describe('v2 (deployed 2026-10-23)', () => {
  async function deploy() {
    const [creator, beneficiary, other] = await ethers.getSigners()
    const vault: Contract = await ethers.deployContract('LockVaultV2')
    const adapter: Contract = await ethers.deployContract('PinkLockAdapterV2', [await vault.getAddress()])
    const token: Contract = await ethers.deployContract('MockToken', ['Mock', 'MOCK'])
    const amount = ethers.parseEther('100')
    await token.mint(creator.address, amount * 10n)
    await as(token, creator).approve(await adapter.getAddress(), ethers.MaxUint256)
    return { vault, adapter, token, creator, beneficiary, other, amount }
  }

  it('adapter.lock creates a v2 lock and refunds attached ETH', async () => {
    const { vault, adapter, token, creator, beneficiary, amount } = await deploy()
    const unlock = (await latest()) + 3600
    const adapterAddress = await adapter.getAddress()

    await (await as(adapter, creator).lock(
      beneficiary.address, await token.getAddress(), false, amount, unlock, 'v2 lock',
      { value: ethers.parseEther('1') },
    )).wait()

    expect(await ethers.provider.getBalance(adapterAddress)).to.equal(0n, 'adapter must not retain ETH')
    expect(await adapter.getTotalLockCount()).to.equal(1n)
    const l = await vault.getLock(1)
    expect(l.amount).to.equal(amount)
    expect(l.beneficiary).to.equal(beneficiary.address)
    expect(await token.balanceOf(await vault.getAddress())).to.equal(amount)
  })

  it('claim is refused before the date and paid to the beneficiary after it', async () => {
    const { adapter, token, creator, beneficiary, other, amount } = await deploy()
    const unlock = (await latest()) + 3600
    await (await as(adapter, creator).lock(
      beneficiary.address, await token.getAddress(), false, amount, unlock, 'claim me',
    )).wait()

    await expect(as(adapter, other).unlock(1)).to.be.reverted

    await jumpTo(unlock + 1)
    await (await as(adapter, other).unlock(1)).wait()
    expect(await token.balanceOf(beneficiary.address)).to.equal(amount)
    expect((await adapter.getLockById(1)).unlockedAmount).to.equal(amount)
  })

  it('editLock and revoke still work through the v2 vault', async () => {
    const { vault, token, creator, beneficiary, amount } = await deploy()
    await as(token, creator).approve(await vault.getAddress(), ethers.MaxUint256)
    const t0 = (await latest()) + 10
    await as(vault, creator).createLock({
      token: await token.getAddress(),
      amount,
      beneficiary: beneficiary.address,
      agent: ethers.ZeroAddress,
      startTime: t0,
      cliffTime: t0 + 100,
      endTime: t0 + 1000,
      initialUnlockBps: 0,
      steps: 0,
      revocable: true,
      transferable: true,
      label: ethers.encodeBytes32String('V2'),
    })
    await jumpTo(t0 + 200)

    const half = amount / 2n
    await as(vault, beneficiary).editLock(1, half, t0 + 500)
    expect((await vault.getLock(1)).amount).to.equal(half)

    await as(vault, creator).revoke(1)
    expect((await vault.getLock(1)).revoked).to.equal(true)
  })

  it('a re-entrant token cannot double-credit a lock (the guard reverts the whole tx)', async () => {
    const { vault, creator } = await deploy()
    const evil: Contract = await ethers.deployContract('MockReentrantToken')
    const amount = ethers.parseEther('100')
    await evil.mint(creator.address, amount)
    await evil.mint(await evil.getAddress(), amount * 2n)
    await as(evil, creator).approve(await vault.getAddress(), ethers.MaxUint256)
    await evil.arm(await vault.getAddress(), ethers.parseEther('50'))

    const t = (await latest()) + 1
    await expect(as(vault, creator).createLock({
      token: await evil.getAddress(),
      amount,
      beneficiary: creator.address,
      agent: ethers.ZeroAddress,
      startTime: t,
      cliffTime: t,
      endTime: t,
      initialUnlockBps: 0,
      steps: 0,
      revocable: false,
      transferable: true,
      label: ethers.encodeBytes32String('evil'),
    })).to.be.revertedWithCustomError(vault, 'ReentrantCall')

    expect(await vault.nextLockId()).to.equal(1n)
    expect(await evil.balanceOf(await vault.getAddress())).to.equal(0n)
  })
})
