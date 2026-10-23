import { expect } from 'chai'
import { ethers } from 'hardhat'
import { latest, jumpTo, at, as, loadFixture } from './helpers'
import type { Contract } from 'ethers'

const BPS = 10_000n

type Params = {
  token: string
  amount: bigint
  beneficiary: string
  agent: string
  startTime: number
  cliffTime: number
  endTime: number
  initialUnlockBps: number
  steps: number
  revocable: boolean
  transferable: boolean
  label: string
}

describe('LockVault', () => {
  async function fixture() {
    const [creator, beneficiary, other] = await ethers.getSigners()
    const vault: Contract = await ethers.deployContract('LockVault')

    const token: Contract = await ethers.deployContract('MockToken', ['Mock', 'MOCK'])
    await token.mint(creator.address, ethers.parseEther('1000000'))
    await as(token, creator).approve(await vault.getAddress(), ethers.MaxUint256)

    const taxed: Contract = await ethers.deployContract('MockToken', ['Taxed', 'TAX'])
    await taxed.mint(creator.address, ethers.parseEther('1000000'))
    await as(taxed, creator).approve(await vault.getAddress(), ethers.MaxUint256)

    const noReturn: Contract = await ethers.deployContract('MockTokenNoReturn')
    await noReturn.mint(creator.address, ethers.parseEther('1000000'))
    await as(noReturn, creator).approve(await vault.getAddress(), ethers.MaxUint256)

    return { vault, token, taxed, noReturn, creator, beneficiary, other }
  }

  /** A linear schedule starting 1000s from now, no unlock at TGE. */
  async function linearParams(
    token: string,
    beneficiary: string,
    overrides: Partial<Params> = {}
  ): Promise<Params> {
    const t0 = (await latest()) + 10
    return {
      token,
      amount: ethers.parseEther('1000'),
      beneficiary,
      // 默认零地址：vault 直建的锁谁都不能代理，和加 agent 之前一模一样
      agent: ethers.ZeroAddress,
      startTime: t0,
      cliffTime: t0,
      endTime: t0 + 1000,
      initialUnlockBps: 0,
      steps: 0,
      revocable: false,
      transferable: false,
      label: ethers.encodeBytes32String('Team'),
      ...overrides,
    }
  }

  describe('creating a lock', () => {
    it('escrows the tokens and records the schedule', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address)

      await expect(as(vault, creator).createLock(p))
        .to.emit(vault, 'LockCreated')
        .withArgs(
          1n,
          p.token,
          creator.address,
          beneficiary.address,
          p.agent,
          p.amount,
          p.startTime,
          p.cliffTime,
          p.endTime,
          p.initialUnlockBps,
          p.steps,
          false,
          false,
          p.label
        )

      expect(await token.balanceOf(await vault.getAddress())).to.equal(p.amount)
      const lock = await vault.getLock(1n)
      expect(lock.creator).to.equal(creator.address)
      expect(lock.beneficiary).to.equal(beneficiary.address)
      expect(lock.amount).to.equal(p.amount)
      expect(lock.claimed).to.equal(0n)
    })

    it('credits what arrived, not what was asked, when the token takes a fee', async () => {
      const { vault, taxed, creator, beneficiary, other } = await loadFixture(fixture)
      await taxed.setFee(300, other.address) // 3%

      const p = await linearParams(await taxed.getAddress(), beneficiary.address)
      const expected = (p.amount * (BPS - 300n)) / BPS

      await expect(as(vault, creator).createLock(p))
        .to.emit(vault, 'LockCreated')
        .withArgs(
          1n,
          p.token,
          creator.address,
          beneficiary.address,
          p.agent,
          expected, // the credited amount, not p.amount
          p.startTime,
          p.cliffTime,
          p.endTime,
          p.initialUnlockBps,
          p.steps,
          false,
          false,
          p.label
        )

      expect((await vault.getLock(1n)).amount).to.equal(expected)
      expect(await taxed.balanceOf(await vault.getAddress())).to.equal(expected)
    })

    it('refuses to create a lock that would be backed by nothing', async () => {
      const { vault, taxed, creator, beneficiary, other } = await loadFixture(fixture)
      await taxed.setFee(10_000, other.address) // taxes the whole transfer

      const p = await linearParams(await taxed.getAddress(), beneficiary.address)
      await expect(as(vault, creator).createLock(p)).to.be.revertedWithCustomError(
        vault,
        'NothingReceived'
      )
      expect(await vault.nextLockId()).to.equal(1n)
    })

    it('rejects a token address with no code', async () => {
      const { vault, creator, beneficiary } = await loadFixture(fixture)
      const p = await linearParams(creator.address, beneficiary.address)
      await expect(as(vault, creator).createLock(p)).to.be.revertedWithCustomError(
        vault,
        'NotAContract'
      )
    })

    it('validates the parameters', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const base = await linearParams(await token.getAddress(), beneficiary.address)

      const zero1 = await linearParams(base.token, ethers.ZeroAddress)
      await expect(as(vault, creator).createLock(zero1)).to.be.revertedWithCustomError(
        vault,
        'ZeroBeneficiary'
      )

      const zero2 = await linearParams(base.token, beneficiary.address, { amount: 0n })
      await expect(as(vault, creator).createLock(zero2)).to.be.revertedWithCustomError(
        vault,
        'ZeroAmount'
      )

      const unordered = await linearParams(base.token, beneficiary.address, {
        cliffTime: base.startTime - 1,
      })
      await expect(as(vault, creator).createLock(unordered)).to.be.revertedWithCustomError(
        vault,
        'UnorderedSchedule'
      )

      const badBps = await linearParams(base.token, beneficiary.address, {
        initialUnlockBps: 10_001,
      })
      await expect(as(vault, creator).createLock(badBps)).to.be.revertedWithCustomError(
        vault,
        'InvalidInitialUnlock'
      )
    })

    it('works with a token that returns nothing, like USDT', async () => {
      const { vault, noReturn, creator, beneficiary } = await loadFixture(fixture)
      const p = await linearParams(await noReturn.getAddress(), beneficiary.address)
      await expect(as(vault, creator).createLock(p)).to.emit(vault, 'LockCreated')
      expect((await vault.getLock(1n)).amount).to.equal(p.amount)
    })
  })

  describe('the vesting curve', () => {
    it('is linear between start and end', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address)
      await as(vault, creator).createLock(p)

      expect(await vault.vestedAt(1n, p.startTime - 1)).to.equal(0n)
      expect(await vault.vestedAt(1n, p.startTime)).to.equal(0n)
      expect(await vault.vestedAt(1n, p.startTime + 250)).to.equal(ethers.parseEther('250'))
      expect(await vault.vestedAt(1n, p.startTime + 500)).to.equal(ethers.parseEther('500'))
      expect(await vault.vestedAt(1n, p.endTime)).to.equal(p.amount)
      expect(await vault.vestedAt(1n, p.endTime + 10_000)).to.equal(p.amount)
    })

    it('releases `initialUnlockBps` at start and spreads the rest', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address, {
        initialUnlockBps: 1000, // 10% at TGE
      })
      await as(vault, creator).createLock(p)

      expect(await vault.vestedAt(1n, p.startTime)).to.equal(ethers.parseEther('100'))
      expect(await vault.vestedAt(1n, p.startTime + 500)).to.equal(ethers.parseEther('550'))
      expect(await vault.vestedAt(1n, p.endTime)).to.equal(p.amount)
    })

    /**
     * The bug this pins down was invisible until the contract was run against a
     * real chain, and it is the reason this test exists rather than a note.
     *
     * The schedule math used to divide twice — `amount * (bps + (10000 - bps) *
     * elapsed / span) / 10000` — and the inner division truncates. On a 90-day
     * schedule the elapsed fraction does not reach one basis point until about
     * thirteen minutes in, so a claim made before then returned zero while time
     * had visibly passed. Every other test here jumps straight to a round
     * fraction of the schedule, where the truncation lands on zero error.
     */
    it('releases something one second in, however long the schedule is', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const t0 = (await latest()) + 10
      const p = await linearParams(await token.getAddress(), beneficiary.address, {
        startTime: t0,
        cliffTime: t0,
        endTime: t0 + 90 * 24 * 3600, // 90 days: 7,776,000 seconds
      })
      await vault.connect(creator).createLock(p)

      const afterOneSecond = await vault.vestedAt(1n, p.startTime + 1)
      expect(afterOneSecond).to.be.greaterThan(0n)

      // And it is the right number, not merely a non-zero one: one part in
      // 7,776,000, to within the single division's rounding.
      const exact = (p.amount * 1n) / 7_776_000n
      expect(afterOneSecond).to.be.closeTo(exact, 1n)
    })

    /** A vesting curve that ever goes backwards is not a vesting curve. */
    it('never decreases as time moves forward', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address, {
        initialUnlockBps: 1234,
      })
      await vault.connect(creator).createLock(p)

      let previous = 0n
      for (let i = 0; i <= 200; i++) {
        const t = p.startTime - 10 + Math.round(((p.endTime - p.startTime + 20) * i) / 200)
        const here = await vault.vestedAt(1n, t)
        expect(here).to.be.greaterThanOrEqual(previous)
        expect(here).to.be.lessThanOrEqual(p.amount)
        previous = here
      }
      expect(previous).to.equal(p.amount)
    })

    it('treats a plain "lock until T" as the degenerate case', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const t = (await latest()) + 1000
      const p = await linearParams(await token.getAddress(), beneficiary.address, {
        startTime: t,
        cliffTime: t,
        endTime: t,
      })
      await as(vault, creator).createLock(p)

      expect(await vault.vestedAt(1n, t - 1)).to.equal(0n)
      expect(await vault.vestedAt(1n, t)).to.equal(p.amount)
      expect(await vault.vestedAt(1n, t + 10_000)).to.equal(p.amount)
    })
  })

  /**
   * The staircase.
   *
   * `steps` is the shape most tokenomics tables are written in — "10% at TGE,
   * then 5% every 30 days" — and it is the same schedule as the continuous one
   * with the tail quantised. These tests pin both halves of that claim: a
   * tranche lands on its date and not a second early, and the two forms agree
   * wherever a boundary falls.
   */
  describe('vested schedules', () => {
    /** 10% at TGE, then 5% every 30 days for 18 months: 18 tranches of 500 bps. */
    async function pinksaleShape(token: string, beneficiary: string) {
      const t0 = (await latest()) + 10
      const day = 86400
      return linearParams(token, beneficiary, {
        startTime: t0,
        cliffTime: t0,
        endTime: t0 + 540 * day,
        initialUnlockBps: 1000,
        steps: 18,
      })
    }

    it('releases a tranche on its date and not one second before', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await pinksaleShape(await token.getAddress(), beneficiary.address)
      await vault.connect(creator).createLock(p)

      const day = 86400
      const ten = (p.amount * 1000n) / 10_000n      // the TGE release
      const fifteen = (p.amount * 1500n) / 10_000n  // after the first tranche

      expect(await vault.vestedAt(1n, p.startTime)).to.equal(ten)
      expect(await vault.vestedAt(1n, p.startTime + 29 * day)).to.equal(ten)
      expect(await vault.vestedAt(1n, p.startTime + 30 * day)).to.equal(fifteen)
      expect(await vault.vestedAt(1n, p.startTime + 30 * day - 1)).to.equal(ten)
    })

    it('lands every tranche on its date and reaches the whole amount at the end', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await pinksaleShape(await token.getAddress(), beneficiary.address)
      await vault.connect(creator).createLock(p)

      const day = 86400
      for (let i = 0; i <= 18; i++) {
        const at = p.startTime + i * 30 * day
        const expected = i === 18
          ? p.amount
          : (p.amount * BigInt(1000 + 500 * i)) / 10_000n
        expect(await vault.vestedAt(1n, at)).to.equal(expected)
      }
    })

    it('agrees with the continuous form at every boundary', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const stepped = await pinksaleShape(await token.getAddress(), beneficiary.address)
      const linear = { ...stepped, steps: 0 }

      await vault.connect(creator).createLock(stepped)
      await vault.connect(creator).createLock(linear)

      const day = 86400
      for (let i = 0; i <= 18; i++) {
        const at = stepped.startTime + i * 30 * day
        expect(await vault.vestedAt(2n, at)).to.equal(await vault.vestedAt(1n, at))
      }
      // And the staircase is never ahead of the line between boundaries.
      for (let s = 0; s <= 30; s++) {
        const at = stepped.startTime + (10 * 30 + s) * day
        expect(await vault.vestedAt(1n, at)).to.be.lessThanOrEqual(await vault.vestedAt(2n, at))
      }
    })

    it('never decreases, and never exceeds the total', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await pinksaleShape(await token.getAddress(), beneficiary.address)
      await vault.connect(creator).createLock(p)

      let previous = 0n
      for (let i = 0; i <= 300; i++) {
        const at = p.startTime - 5 + Math.round(((540 * 86400 + 10) * i) / 300)
        const here = await vault.vestedAt(1n, at)
        expect(here).to.be.greaterThanOrEqual(previous)
        expect(here).to.be.lessThanOrEqual(p.amount)
        previous = here
      }
      expect(previous).to.equal(p.amount)
    })

    it('treats one step as a single release at the end', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address, {
        initialUnlockBps: 0,
        steps: 1,
      })
      await vault.connect(creator).createLock(p)

      expect(await vault.vestedAt(1n, p.startTime)).to.equal(0n)
      expect(await vault.vestedAt(1n, p.endTime - 1)).to.equal(0n)
      expect(await vault.vestedAt(1n, p.endTime)).to.equal(p.amount)
    })

    it('refuses more tranches than there are basis points to release', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      // 10% released at the start leaves 9000 bps, so 9001 tranches is one too many.
      const tooMany = await linearParams(await token.getAddress(), beneficiary.address, {
        initialUnlockBps: 1000,
        steps: 9001,
      })
      await expect(vault.connect(creator).createLock(tooMany)).to.be.revertedWithCustomError(
        vault,
        'TooManySteps'
      )

      // Exactly at the ceiling is fine, and degenerates to the continuous form.
      const atCeiling = await linearParams(await token.getAddress(), beneficiary.address, {
        initialUnlockBps: 1000,
        steps: 9000,
      })
      await expect(vault.connect(creator).createLock(atCeiling)).to.emit(vault, 'LockCreated')
    })

    it('records the tranche count in the event', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await pinksaleShape(await token.getAddress(), beneficiary.address)
      await expect(vault.connect(creator).createLock(p))
        .to.emit(vault, 'LockCreated')
        .withArgs(
          1n, p.token, creator.address, beneficiary.address, p.agent, p.amount,
          p.startTime, p.cliffTime, p.endTime, p.initialUnlockBps, 18,
          false, false, p.label
        )
    })
  })

  describe('claiming', () => {
    it('pays the beneficiary, and anyone may pay the gas', async () => {
      const { vault, token, creator, beneficiary, other } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address)
      await as(vault, creator).createLock(p)

      const before = await token.balanceOf(beneficiary.address)

      // A third party submits; the tokens still go to the beneficiary.
      await expect(at(p.startTime + 500, () => as(vault, other).claim(1n)))
        .to.emit(vault, 'Claimed')
        .withArgs(1n, beneficiary.address, ethers.parseEther('500'))

      expect(await token.balanceOf(beneficiary.address)).to.equal(before + ethers.parseEther('500'))
      expect((await vault.getLock(1n)).claimed).to.equal(ethers.parseEther('500'))
    })

    it('never pays more than has vested', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address)
      await as(vault, creator).createLock(p)

      await at(p.startTime + 250, () => vault.claim(1n))
      expect((await vault.getLock(1n)).claimed).to.equal(ethers.parseEther('250'))

      await at(p.startTime + 500, () => vault.claim(1n))
      expect((await vault.getLock(1n)).claimed).to.equal(ethers.parseEther('500'))

      await at(p.endTime, () => vault.claim(1n))
      expect((await vault.getLock(1n)).claimed).to.equal(p.amount)

      // Fully claimed: nothing left, and the vault's balance is drained.
      await expect(vault.claim(1n)).to.be.revertedWithCustomError(vault, 'NothingClaimable')
      expect(await token.balanceOf(await vault.getAddress())).to.equal(0n)
    })

    it('releases nothing before the cliff, then everything accrued', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address, {
        cliffTime: (await latest()) + 110, // start + 100
      })
      await as(vault, creator).createLock(p)

      // Accrual runs behind the cliff even though nothing can be withdrawn.
      // Two seconds short, so the block itself is at `cliffTime - 2` and the
      // call that follows lands on `cliffTime - 1`, still inside the cliff.
      await jumpTo(p.cliffTime - 2)
      expect(await vault.vestedAt(1n, p.cliffTime - 1)).to.equal(ethers.parseEther('99'))
      expect(await vault.claimable(1n)).to.equal(0n)
      await expect(vault.claim(1n)).to.be.revertedWithCustomError(vault, 'NothingClaimable')

      await jumpTo(p.cliffTime)
      expect(await vault.claimable(1n)).to.equal(ethers.parseEther('100'))
      await expect(vault.claim(1n)).to.emit(vault, 'Claimed')
    })

    it('reports unknown ids as unknown', async () => {
      const { vault } = await loadFixture(fixture)
      await expect(vault.claim(99n)).to.be.revertedWithCustomError(vault, 'UnknownLock')
      await expect(vault.claimable(99n)).to.be.revertedWithCustomError(vault, 'UnknownLock')
    })
  })

  describe('revoking', () => {
    it('refunds the unvested part and freezes what has vested', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address, {
        revocable: true,
      })
      await as(vault, creator).createLock(p)

      const creatorBefore = await token.balanceOf(creator.address)

      // The two halves the event reports must sum to the credited amount.
      const vested = ethers.parseEther('250')
      const refunded = p.amount - vested
      await expect(at(p.startTime + 250, () => as(vault, creator).revoke(1n)))
        .to.emit(vault, 'Revoked')
        .withArgs(1n, creator.address, refunded, vested)

      expect(await token.balanceOf(creator.address)).to.equal(creatorBefore + refunded)

      const lock = await vault.getLock(1n)
      expect(lock.revoked).to.equal(true)
      expect(lock.amount).to.equal(vested)

      // The schedule is frozen: nothing more accrues, ever.
      expect(await vault.vestedAt(1n, p.endTime + 10_000)).to.equal(vested)

      // The vested part is still the beneficiary's to take.
      await expect(vault.claim(1n))
        .to.emit(vault, 'Claimed')
        .withArgs(1n, beneficiary.address, vested)
      expect(await token.balanceOf(await vault.getAddress())).to.equal(0n)
    })

    it('only counts what has not already been claimed', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address, {
        revocable: true,
      })
      await as(vault, creator).createLock(p)

      await at(p.startTime + 250, () => vault.claim(1n)) // beneficiary takes 250

      // 500 vested, 250 already paid: the creator gets the other 500 back.
      await expect(at(p.startTime + 500, () => as(vault, creator).revoke(1n)))
        .to.emit(vault, 'Revoked')
        .withArgs(1n, creator.address, ethers.parseEther('500'), ethers.parseEther('500'))

      await expect(vault.claim(1n)).to.emit(vault, 'Claimed')
      await expect(vault.claim(1n)).to.be.revertedWithCustomError(vault, 'NothingClaimable')
      expect(await token.balanceOf(await vault.getAddress())).to.equal(0n)
    })

    it('is refused when not revocable, by a non-creator, or twice', async () => {
      const { vault, token, creator, beneficiary, other } = await loadFixture(fixture)
      const fixed = await linearParams(await token.getAddress(), beneficiary.address)
      await as(vault, creator).createLock(fixed)
      await expect(as(vault, creator).revoke(1n)).to.be.revertedWithCustomError(
        vault,
        'NotRevocable'
      )

      const open = await linearParams(await token.getAddress(), beneficiary.address, {
        revocable: true,
      })
      await as(vault, creator).createLock(open)

      await expect(as(vault, other).revoke(2n)).to.be.revertedWithCustomError(
        vault,
        'NotCreator'
      )
      await as(vault, creator).revoke(2n)
      await expect(as(vault, creator).revoke(2n)).to.be.revertedWithCustomError(
        vault,
        'AlreadyRevoked'
      )
    })
  })

  /**
   * Renouncing: give up the claim permanently.
   *
   * This is the strongest statement the contract can make — not "these cannot
   * move until a date" but "these cannot move again" — and it only means
   * anything if nothing can undo it. So each of the three ways out is pinned.
   */
  describe('renouncing', () => {
    async function renounceable() {
      const { vault, token, creator, beneficiary, other } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address, {
        revocable: true,
        transferable: true,
      })
      await vault.connect(creator).createLock(p)
      return { vault, token, creator, beneficiary, other, p }
    }

    it('makes the tokens permanently unreachable', async () => {
      const { vault, token, creator, beneficiary, p } = await renounceable()

      await expect(vault.connect(beneficiary).renounce(1n))
        .to.emit(vault, 'Renounced')
        .withArgs(1n, beneficiary.address)

      expect((await vault.getLock(1n)).renounced).to.equal(true)
      expect(await vault.claimable(1n)).to.equal(0n)

      // Well past the end, with the whole schedule vested.
      await jumpTo(p.endTime + 10_000)
      expect(await vault.claimable(1n)).to.equal(0n)
      await expect(vault.claim(1n)).to.be.revertedWithCustomError(vault, 'LockRenounced')

      // The tokens are still there. That is the point.
      expect(await token.balanceOf(await vault.getAddress())).to.equal(p.amount)
    })

    it('blocks the creator from taking the unvested part back too', async () => {
      const { vault, creator, beneficiary } = await renounceable()
      await vault.connect(beneficiary).renounce(1n)

      // Otherwise "nobody can take these" would not be true.
      await expect(vault.connect(creator).revoke(1n)).to.be.revertedWithCustomError(
        vault,
        'LockRenounced'
      )
    })

    it('cannot be handed on afterwards', async () => {
      const { vault, beneficiary, other } = await renounceable()
      await vault.connect(beneficiary).renounce(1n)
      await expect(vault.connect(beneficiary).transferLock(1n, other.address))
        .to.be.revertedWithCustomError(vault, 'LockRenounced')
    })

    it('is only the beneficiary, and only once', async () => {
      const { vault, creator, beneficiary } = await renounceable()
      await expect(vault.connect(creator).renounce(1n)).to.be.revertedWithCustomError(
        vault,
        'NotBeneficiary'
      )
      await vault.connect(beneficiary).renounce(1n)
      await expect(vault.connect(beneficiary).renounce(1n)).to.be.revertedWithCustomError(
        vault,
        'AlreadyRenounced'
      )
    })

    it('leaves an ordinary lock alone until someone renounces it', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address)
      await vault.connect(creator).createLock(p)

      expect((await vault.getLock(1n)).renounced).to.equal(false)
      await jumpTo(p.endTime)
      await expect(vault.claim(1n)).to.emit(vault, 'Claimed')
    })
  })

  describe('transferring the lock', () => {
    it('moves the beneficiary when the lock allows it', async () => {
      const { vault, token, creator, beneficiary, other } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address, {
        transferable: true,
      })
      await as(vault, creator).createLock(p)

      await expect(as(vault, beneficiary).transferLock(1n, other.address))
        .to.emit(vault, 'LockTransferred')
        .withArgs(1n, beneficiary.address, other.address)

      await jumpTo(p.endTime)
      await vault.claim(1n)
      expect(await token.balanceOf(other.address)).to.equal(p.amount)
    })

    it('is refused when not transferable, or by a non-beneficiary', async () => {
      const { vault, token, creator, beneficiary, other } = await loadFixture(fixture)
      const fixed = await linearParams(await token.getAddress(), beneficiary.address)
      await as(vault, creator).createLock(fixed)
      await expect(
        as(vault, beneficiary).transferLock(1n, other.address)
      ).to.be.revertedWithCustomError(vault, 'NotTransferable')

      const open = await linearParams(await token.getAddress(), beneficiary.address, {
        transferable: true,
      })
      await as(vault, creator).createLock(open)
      await expect(as(vault, other).transferLock(2n, other.address)).to.be.revertedWithCustomError(
        vault,
        'NotBeneficiary'
      )
      await expect(
        as(vault, beneficiary).transferLock(2n, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, 'ZeroBeneficiary')
    })
  })

  describe('invariants across a whole schedule', () => {
    /**
     * The property that has to hold for the product to mean anything: the vault
     * never pays out more than it holds, and after the schedule ends and every
     * claim is made it holds nothing at all.
     */
    it('never over-pays, and empties exactly when fully claimed', async () => {
      const { vault, token, creator, beneficiary } = await loadFixture(fixture)
      const p = await linearParams(await token.getAddress(), beneficiary.address)
      await as(vault, creator).createLock(p)

      for (const step of [100, 200, 300, 400]) {
        await jumpTo(p.startTime + step)
        if ((await vault.claimable(1n)) > 0n) await vault.claim(1n)
        expect(await token.balanceOf(await vault.getAddress())).to.be.gte(0n)
        expect((await vault.getLock(1n)).claimed).to.be.lte(p.amount)
      }

      await jumpTo(p.endTime + 1)
      await vault.claim(1n)

      expect((await vault.getLock(1n)).claimed).to.equal(p.amount)
      expect(await token.balanceOf(await vault.getAddress())).to.equal(0n)
      expect(await token.balanceOf(beneficiary.address)).to.equal(p.amount)
    })
  })
})
