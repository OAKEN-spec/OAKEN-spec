import { expect } from 'chai'
import { ethers } from 'hardhat'
import { latest, jumpTo, as, loadFixture } from './helpers'
import type { Contract } from 'ethers'

describe('PositionLock', () => {
  async function fixture() {
    const [creator, beneficiary, operator, other] = await ethers.getSigners()
    const lock: Contract = await ethers.deployContract('PositionLock')
    const nft: Contract = await ethers.deployContract('MockPosition')
    await nft.mint(creator.address, 7n)
    await as(nft, creator).approve(await lock.getAddress(), 7n)
    return { lock, nft, creator, beneficiary, operator, other }
  }

  async function params(overrides: Record<string, unknown> = {}) {
    return {
      nft: '',
      tokenId: 7n,
      beneficiary: '',
      unlockTime: (await latest()) + 1000,
      revocable: false,
      label: ethers.encodeBytes32String('Uniswap V3 LP'),
      ...overrides,
    }
  }

  describe('locking a position', () => {
    it('moves the position into escrow and records the lock', async () => {
      const { lock, nft, creator, beneficiary } = await loadFixture(fixture)
      const p = await params({
        nft: await nft.getAddress(),
        beneficiary: beneficiary.address,
      })

      await expect(as(lock, creator).lockPosition(p))
        .to.emit(lock, 'PositionLocked')
        .withArgs(
          1n,
          p.nft,
          7n,
          creator.address,
          beneficiary.address,
          p.unlockTime,
          false,
          p.label
        )

      expect(await nft.ownerOf(7n)).to.equal(await lock.getAddress())
      const record = await lock.getLock(1n)
      expect(record.creator).to.equal(creator.address)
      expect(record.beneficiary).to.equal(beneficiary.address)
      expect(record.released).to.equal(false)
    })

    it('refuses a position the caller does not own', async () => {
      const { lock, nft, creator, beneficiary, other } = await loadFixture(fixture)
      const p = await params({
        nft: await nft.getAddress(),
        beneficiary: beneficiary.address,
      })

      await nft.mint(other.address, 8n)
      await as(nft, other).approve(await lock.getAddress(), 8n)
      const theirs = { ...p, tokenId: 8n }
      // `other` owns 8, so their own call works; `creator` calling for it does not.
      await expect(as(lock, creator).lockPosition(theirs)).to.be.revertedWithCustomError(
        lock,
        'NotPositionOwner'
      )
      await expect(as(lock, other).lockPosition(theirs)).to.emit(lock, 'PositionLocked')
    })

    it('refuses an unlock time that has already passed', async () => {
      const { lock, nft, creator, beneficiary } = await loadFixture(fixture)
      const p = await params({
        nft: await nft.getAddress(),
        beneficiary: beneficiary.address,
        unlockTime: await latest(),
      })
      await expect(as(lock, creator).lockPosition(p)).to.be.revertedWithCustomError(
        lock,
        'UnlockTimeInPast'
      )
    })

    it('refuses a zero beneficiary and a non-contract collection', async () => {
      const { lock, nft, creator } = await loadFixture(fixture)
      await expect(
        as(lock, creator).lockPosition(
          await params({ nft: await nft.getAddress(), beneficiary: ethers.ZeroAddress })
        )
      ).to.be.revertedWithCustomError(lock, 'ZeroBeneficiary')

      await expect(
        as(lock, creator).lockPosition(
          await params({ nft: creator.address, beneficiary: creator.address })
        )
      ).to.be.revertedWithCustomError(lock, 'NotAContract')
    })
  })

  describe('the escrow actually holds the position', () => {
    /**
     * The guarantee rests entirely on ERC-721's authorisation rules, so pin
     * them: while escrowed, neither the creator nor an operator the creator
     * appointed beforehand can move the position. If a future refactor ever
     * changed how the position enters escrow, these are the tests that fail.
     */
    it('cannot be moved by the creator', async () => {
      const { lock, nft, creator, beneficiary } = await loadFixture(fixture)
      await as(lock, creator).lockPosition(
        await params({ nft: await nft.getAddress(), beneficiary: beneficiary.address })
      )

      await expect(
        as(nft, creator).transferFrom(await lock.getAddress(), creator.address, 7n)
      ).to.be.revertedWith('not authorized')
    })

    it('cannot be moved by an operator approved before the lock', async () => {
      const { lock, nft, creator, beneficiary, operator } = await loadFixture(fixture)
      // Approve the operator over everything the creator owns, then lock.
      await as(nft, creator).setApprovalForAll(operator.address, true)
      await as(lock, creator).lockPosition(
        await params({ nft: await nft.getAddress(), beneficiary: beneficiary.address })
      )

      // Operator status is scoped to what its approver owns; the escrow is the
      // owner now, so the approval no longer reaches this token.
      await expect(
        as(nft, operator).transferFrom(await lock.getAddress(), operator.address, 7n)
      ).to.be.revertedWith('not authorized')
    })
  })

  describe('releasing', () => {
    it('sends the position to the beneficiary once unlocked, from any caller', async () => {
      const { lock, nft, creator, beneficiary, other } = await loadFixture(fixture)
      const p = await params({
        nft: await nft.getAddress(),
        beneficiary: beneficiary.address,
      })
      await as(lock, creator).lockPosition(p)

      await jumpTo(p.unlockTime)
      await expect(as(lock, other).release(1n))
        .to.emit(lock, 'PositionReleased')
        .withArgs(1n, beneficiary.address, 7n)

      expect(await nft.ownerOf(7n)).to.equal(beneficiary.address)
      expect((await lock.getLock(1n)).released).to.equal(true)
    })

    it('refuses before the unlock time and refuses a second release', async () => {
      const { lock, nft, creator, beneficiary } = await loadFixture(fixture)
      const p = await params({
        nft: await nft.getAddress(),
        beneficiary: beneficiary.address,
      })
      await as(lock, creator).lockPosition(p)

      await expect(lock.release(1n)).to.be.revertedWithCustomError(lock, 'StillLocked')

      await jumpTo(p.unlockTime)
      await lock.release(1n)
      await expect(lock.release(1n)).to.be.revertedWithCustomError(lock, 'AlreadyReleased')
    })

    it('reports releasability, which is the question the badge asks', async () => {
      const { lock, nft, creator, beneficiary } = await loadFixture(fixture)
      const p = await params({
        nft: await nft.getAddress(),
        beneficiary: beneficiary.address,
      })
      await as(lock, creator).lockPosition(p)

      expect(await lock.isReleasable(1n)).to.equal(false)
      await jumpTo(p.unlockTime)
      expect(await lock.isReleasable(1n)).to.equal(true)
      await lock.release(1n)
      expect(await lock.isReleasable(1n)).to.equal(false)
    })
  })

  describe('reclaiming', () => {
    it('returns a revocable position to its creator', async () => {
      const { lock, nft, creator, beneficiary } = await loadFixture(fixture)
      const p = await params({
        nft: await nft.getAddress(),
        beneficiary: beneficiary.address,
        revocable: true,
      })
      await as(lock, creator).lockPosition(p)

      await expect(as(lock, creator).reclaim(1n))
        .to.emit(lock, 'PositionReclaimed')
        .withArgs(1n, creator.address, 7n)
      expect(await nft.ownerOf(7n)).to.equal(creator.address)
    })

    /**
     * Documented behaviour, not an accident: a revocable lock stays reclaimable
     * after its unlock time. The beneficiary's protection is that release is
     * open to anyone the moment the time passes, so this is a race the creator
     * loses by being late, and forbidding it after `unlockTime` would only add a
     * second way for the two sides to disagree about when the lock ended.
     */
    it('stays reclaimable after the unlock time, until someone releases', async () => {
      const { lock, nft, creator, beneficiary } = await loadFixture(fixture)
      const p = await params({
        nft: await nft.getAddress(),
        beneficiary: beneficiary.address,
        revocable: true,
      })
      await as(lock, creator).lockPosition(p)

      await jumpTo(p.unlockTime + 10_000)
      await expect(as(lock, creator).reclaim(1n)).to.emit(lock, 'PositionReclaimed')
      expect(await nft.ownerOf(7n)).to.equal(creator.address)
    })

    it('is refused when not revocable, by a non-creator, or after release', async () => {
      const { lock, nft, creator, beneficiary, other } = await loadFixture(fixture)
      const fixed = await params({
        nft: await nft.getAddress(),
        beneficiary: beneficiary.address,
      })
      await as(lock, creator).lockPosition(fixed)
      await expect(as(lock, creator).reclaim(1n)).to.be.revertedWithCustomError(
        lock,
        'NotRevocable'
      )

      await nft.mint(creator.address, 9n)
      await as(nft, creator).approve(await lock.getAddress(), 9n)
      const open = { ...fixed, tokenId: 9n, revocable: true }
      await as(lock, creator).lockPosition(open)

      await expect(as(lock, other).reclaim(2n)).to.be.revertedWithCustomError(
        lock,
        'NotCreator'
      )

      await jumpTo(open.unlockTime)
      await as(lock, beneficiary).release(2n)
      await expect(as(lock, creator).reclaim(2n)).to.be.revertedWithCustomError(
        lock,
        'AlreadyReleased'
      )
    })
  })

  describe('the receiver hook', () => {
    /**
     * `safeTransferFrom` into the escrow would leave a position with no lock
     * record, and this contract has no rescue function, so it would be stuck
     * forever. The hook rejects everything instead.
     */
    it('refuses a position pushed in by safeTransferFrom', async () => {
      const { lock, nft, creator } = await loadFixture(fixture)
      await expect(
        as(nft, creator).safeTransferFrom(creator.address, await lock.getAddress(), 7n)
      ).to.be.revertedWithCustomError(lock, 'UnexpectedToken')
    })

    it('answers the EIP-721 magic value for the sentinel id only', async () => {
      const { lock } = await loadFixture(fixture)
      expect(
        await lock.onERC721Received.staticCall(ethers.ZeroAddress, ethers.ZeroAddress, 0n, '0x')
      ).to.equal('0x150b7a02')
    })
  })
})
