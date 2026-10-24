import { expect } from 'chai'
import { ethers } from 'hardhat'
import { latest, jumpTo, at, as } from './helpers'
import type { Contract } from 'ethers'

/**
 * v3 — V2 plus the `revoke` clamp (2026-10-24).
 *
 * The regression at the bottom is the reason v3 exists: a revocable lock can be
 * edited down after a partial claim, and the vesting curve then vests less than
 * was already paid. V2's `revoke` froze `amount` at `vestedNow` and refunded the
 * difference — more than the vault still held for that lock, i.e. it paid the
 * creator out of other locks' tokens.
 */
describe('v3 (revoke clamp)', () => {
  async function deploy() {
    const [creator, beneficiary, other] = await ethers.getSigners()
    const vault: Contract = await ethers.deployContract('LockVaultV3')
    const adapter: Contract = await ethers.deployContract('PinkLockAdapterV3', [await vault.getAddress()])
    const token: Contract = await ethers.deployContract('MockToken', ['Mock', 'MOCK'])
    const amount = ethers.parseEther('100')
    await token.mint(creator.address, amount * 10n)
    await as(token, creator).approve(await adapter.getAddress(), ethers.MaxUint256)
    return { vault, adapter, token, creator, beneficiary, other, amount }
  }

  it('adapter.lock creates a v3 lock and refunds attached ETH', async () => {
    const { vault, adapter, token, creator, beneficiary, amount } = await deploy()
    const unlock = (await latest()) + 3600
    const adapterAddress = await adapter.getAddress()

    await (await as(adapter, creator).lock(
      beneficiary.address, await token.getAddress(), false, amount, unlock, 'v3 lock',
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

  it('editLock and revoke still work through the v3 vault', async () => {
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
      label: ethers.encodeBytes32String('V3'),
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

  /**
   * PoC for the bug V3 fixes. Sequence:
   *   claim 50 at half-way, edit 100 -> 60 (allowed: 60 >= claimed 50), the
   *   curve now vests 36 at the same moment; revoke must NOT refund 24.
   *
   * Lock B in the same token is the witness: under V2 the refund came out of
   * B's tokens (vault 86 instead of 100), so B could no longer pay its
   * beneficiary. Under V3 the refund stops at `claimed`.
   */
  it('revoke after a downward edit cannot pay the creator out of another lock', async () => {
    const { vault, token, creator, beneficiary, other, amount } = await deploy()
    const vaultAddress = await vault.getAddress()
    const tokenAddress = await token.getAddress()
    await as(token, creator).approve(vaultAddress, ethers.MaxUint256)
    const t0 = (await latest()) + 10

    const params = (who: string, revocable: boolean) => ({
      token: tokenAddress,
      amount,
      beneficiary: who,
      agent: ethers.ZeroAddress,
      startTime: t0,
      cliffTime: t0,
      endTime: t0 + 1000,
      initialUnlockBps: 0,
      steps: 0,
      revocable,
      transferable: true,
      label: ethers.ZeroHash,
    })

    await (await as(vault, creator).createLock(params(beneficiary.address, true))).wait()  // A
    await (await as(vault, creator).createLock(params(other.address, false))).wait()       // B
    expect(await token.balanceOf(vaultAddress)).to.equal(amount * 2n)

    // 50 has vested on A: claim it, leaving 50 unclaimed of A + 100 of B.
    await at(t0 + 500, () => as(vault, other).claim(1))
    expect((await vault.getLock(1)).claimed).to.equal(amount / 2n)

    // Beneficiary edits A down to 60 — allowed, since 60 >= claimed 50.
    // The vault returns 40. It now holds 110: 10 for A, 100 for B.
    await at(t0 + 502, () => as(vault, beneficiary).editLock(1, (amount * 6n) / 10n, t0 + 1000))
    expect((await vault.getLock(1)).amount).to.equal((amount * 6n) / 10n)
    expect(await token.balanceOf(vaultAddress)).to.equal(amount + (amount / 10n))

    // At t0+600 the 60-token curve vests 36 — less than the 50 already paid.
    // Refunding 60-36 would take 14 from B. V3 clamps the frozen amount to 50.
    await at(t0 + 600, () => as(vault, creator).revoke(1))
    const a = await vault.getLock(1)
    expect(a.revoked).to.equal(true)
    expect(a.amount).to.equal(amount / 2n, 'frozen at claimed, not at vestedNow')
    expect(a.claimed).to.equal(amount / 2n)
    expect(await token.balanceOf(vaultAddress)).to.equal(amount, 'B\'s 100 must still be fully covered')

    // B is untouched and pays out in full at its own date.
    await at(t0 + 1000, () => as(vault, other).claim(2))
    expect(await token.balanceOf(other.address)).to.equal(amount)
    expect(await token.balanceOf(vaultAddress)).to.equal(0n)
  })
})
