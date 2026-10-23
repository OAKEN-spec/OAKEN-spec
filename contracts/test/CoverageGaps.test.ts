import { expect } from 'chai'
import { ethers, network } from 'hardhat'
import { latest, jumpTo, as } from './helpers'
import type { Contract } from 'ethers'

/**
 * Coverage-gap tests.
 *
 * These are deliberately small and targeted: the main suites already pin the
 * behaviour, and these exercise the refusal/view branches that only a specific
 * kind of token or caller reaches. They are part of the >95% coverage gate in
 * the audit-readiness package — not a substitute for the fuzz/invariant suites
 * under test/foundry.
 */
describe('coverage gaps', () => {
  it('editLock refuses a non-plain end time before the cliff', async () => {
    const [creator, beneficiary] = await ethers.getSigners()
    const vault: Contract = await ethers.deployContract('LockVault')
    const token: Contract = await ethers.deployContract('MockToken', ['Mock', 'MOCK'])
    const amount = ethers.parseEther('100')
    await token.mint(creator.address, amount)
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
      revocable: false,
      transferable: false,
      label: ethers.encodeBytes32String('VEST'),
    })
    await jumpTo(t0 + 200)

    await expect(as(vault, beneficiary).editLock(1, amount, t0 + 50))
      .to.be.revertedWithCustomError(vault, 'UnorderedSchedule')
      .withArgs(t0, t0 + 100, t0 + 50)
  })

  it('turns an empty token revert into TransferFailed', async () => {
    const [creator, beneficiary] = await ethers.getSigners()
    const vault: Contract = await ethers.deployContract('LockVault')
    const token: Contract = await ethers.deployContract('MockTokenRevertsEmpty')
    const amount = ethers.parseEther('100')
    await token.mint(creator.address, amount)
    await as(token, creator).approve(await vault.getAddress(), ethers.MaxUint256)
    const t0 = (await latest()) + 10

    await expect(as(vault, creator).createLock({
      token: await token.getAddress(),
      amount,
      beneficiary: beneficiary.address,
      agent: ethers.ZeroAddress,
      startTime: t0,
      cliffTime: t0,
      endTime: t0,
      initialUnlockBps: 0,
      steps: 0,
      revocable: false,
      transferable: false,
      label: ethers.encodeBytes32String('EMPTY'),
    }))
      .to.be.revertedWithCustomError(vault, 'TransferFailed')
      .withArgs(await token.getAddress())
  })

  it('bubbles a token revert reason unchanged', async () => {
    const [creator, beneficiary] = await ethers.getSigners()
    const vault: Contract = await ethers.deployContract('LockVault')
    const token: Contract = await ethers.deployContract('MockToken', ['Mock', 'MOCK'])
    await as(token, creator).approve(await vault.getAddress(), ethers.MaxUint256)
    const t0 = (await latest()) + 10

    await expect(as(vault, creator).createLock({
      token: await token.getAddress(),
      amount: 1n,
      beneficiary: beneficiary.address,
      agent: ethers.ZeroAddress,
      startTime: t0,
      cliffTime: t0,
      endTime: t0,
      initialUnlockBps: 0,
      steps: 0,
      revocable: false,
      transferable: false,
      label: ethers.encodeBytes32String('REASON'),
    })).to.be.revertedWith('balance')
  })

  it('exposes campaignCount and allCampaigns on an empty airdrop', async () => {
    const airdrop: Contract = await ethers.deployContract('OakenAirdrop')
    expect(await airdrop.campaignCount()).to.equal(0n)
    expect(await airdrop.allCampaigns()).to.deep.equal([])
  })

  it('lets the timelock change its own roles and delay', async () => {
    const [proposer, canceller, other] = await ethers.getSigners()
    const tl: Contract = await ethers.deployContract('OakenTimelock', [
      86_400, [proposer.address], [canceller.address],
    ])
    const address = await tl.getAddress()
    await network.provider.send('hardhat_impersonateAccount', [address])
    await network.provider.send('hardhat_setBalance', [address, '0x1000000000000000000'])
    const self = await ethers.getSigner(address)

    await as(tl, self).setProposer(other.address, true)
    expect(await tl.isProposer(other.address)).to.equal(true)
    await as(tl, self).setCanceller(other.address, true)
    expect(await tl.isCanceller(other.address)).to.equal(true)
    await as(tl, self).setDelay(1)
    expect(await tl.delay()).to.equal(1n)

    await expect(as(tl, self).setProposer(ethers.ZeroAddress, true))
      .to.be.revertedWithCustomError(tl, 'ZeroAddress')
    await expect(as(tl, self).setCanceller(ethers.ZeroAddress, true))
      .to.be.revertedWithCustomError(tl, 'ZeroAddress')

    await network.provider.send('hardhat_stopImpersonatingAccount', [address])
  })

  it('exposes PositionLock nextLockId', async () => {
    const lock: Contract = await ethers.deployContract('PositionLock')
    expect(await lock.nextLockId()).to.equal(1n)
  })

  it('exposes Presale promisedTokens', async () => {
    const [creator] = await ethers.getSigners()
    const token: Contract = await ethers.deployContract('MockToken', ['Sale', 'SALE'])
    const now = await latest()
    const sale: Contract = await ethers.deployContract('Presale', [
      await token.getAddress(),
      creator.address,
      now + 600,
      now + 86_400,
      ethers.parseEther('5'),
      ethers.parseEther('20'),
      ethers.parseEther('0.01'),
      ethers.parseEther('10'),
      ethers.parseEther('10000'),
      ethers.ZeroAddress,
      0,
    ])
    expect(await sale.promisedTokens()).to.equal(ethers.parseEther('200000'))
  })

  it('exposes the PinkLockAdapter read surface', async () => {
    const [user] = await ethers.getSigners()
    const vault: Contract = await ethers.deployContract('LockVault')
    const adapter: Contract = await ethers.deployContract('PinkLockAdapter', [await vault.getAddress()])
    const token: Contract = await ethers.deployContract('MockToken', ['Mock', 'MOCK'])
    const amount = ethers.parseEther('1000')
    await token.mint(user.address, amount)
    await as(token, user).approve(await adapter.getAddress(), ethers.MaxUint256)
    const unlock = (await latest()) + 86_400
    await as(adapter, user).lock(user.address, await token.getAddress(), false, amount, unlock, 'Team')

    const one = await adapter.getLockById(1)
    expect(one.owner).to.equal(user.address)
    expect((await adapter.getLockAt(0)).id).to.equal(1n)
    expect((await adapter.getLocksForToken(await token.getAddress(), 0, 0)).length).to.equal(1)
    expect(await adapter.totalLockCountForToken(await token.getAddress())).to.equal(1n)
    expect(await adapter.getTotalLockCount()).to.equal(1n)
    expect(await adapter.withdrawableTokens(1)).to.equal(0n)
    expect((await adapter.cumulativeLockInfo(await token.getAddress()))[2]).to.equal(amount)
    expect((await adapter.getCumulativeNormalTokenLockInfo(0, 0)).length).to.equal(1)
    expect((await adapter.getCumulativeLpTokenLockInfo(0, 0)).length).to.equal(1)
    expect((await adapter.getCumulativeNormalTokenLockInfoAt(0)).id).to.equal(1n)
    expect((await adapter.getCumulativeLpTokenLockInfoAt(0)).id).to.equal(1n)
    expect((await adapter.normalLocksForUser(user.address)).length).to.equal(1)
    expect((await adapter.lpLocksForUser(user.address)).length).to.equal(1)
    expect((await adapter.normalLockForUserAtIndex(user.address, 0)).id).to.equal(1n)
    expect((await adapter.lpLockForUserAtIndex(user.address, 0)).id).to.equal(1n)
    expect(await adapter.normalLockCountForUser(user.address)).to.equal(1n)
    expect(await adapter.lpLockCountForUser(user.address)).to.equal(1n)
    expect(await adapter.totalLockCountForUser(user.address)).to.equal(1n)
    expect(await adapter.allNormalTokenLockedCount()).to.equal(1n)
    expect(await adapter.allLpTokenLockedCount()).to.equal(1n)
    expect(await adapter.totalTokenLockedCount()).to.equal(1n)
    expect(await adapter.paused()).to.equal(false)

    await expect(adapter.multipleVestingLock(
      [], [], user.address, false, 0, 0, 0, 0, '',
    )).to.be.revertedWithCustomError(adapter, 'Unsupported')
  })
})
