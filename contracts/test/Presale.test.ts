import { expect } from 'chai'
import { ethers } from 'hardhat'
import { as, jumpTo, latest } from './helpers'
import type { Contract } from 'ethers'

/**
 * The sale, end to end, in both of its endings.
 *
 * A presale has two ways to finish and the tests have to cover both as
 * *outcomes*, not as branches: money back when the soft cap is missed, tokens
 * out when it is not. The assertions are all on balances — the contract's own
 * counters (`raised`, `claimedTokens`) are checked too, but they are never the
 * evidence, because a counter that disagrees with the token balance is exactly
 * the bug this contract must not have.
 *
 * The invariant the factory enforces gets its own test with the numbers that
 * would break it (a six-decimal token with an eighteen-decimal rate), because
 * the failure it prevents is silent: a fully subscribed sale whose last buyer
 * finds an empty contract.
 */
describe('Presale + PresaleFactory', () => {
  const DAY = 86400
  const ETH = ethers.parseEther

  async function fixture(opts: { decimals?: number; router?: boolean } = {}) {
    const [creator, alice, bob, carol] = await ethers.getSigners()
    const factory: Contract = await ethers.deployContract('PresaleFactory')
    const token: Contract = await ethers.deployContract('MockToken', ['Sale Token', 'SALE'])

    let router = ethers.ZeroAddress
    let routerC: Contract | null = null
    if (opts.router) {
      routerC = await ethers.deployContract('MockRouter')
      router = await routerC.getAddress()
    }

    await token.mint(creator.address, ETH('10000000'))
    await as(token, creator).approve(await factory.getAddress(), ethers.MaxUint256)

    const now = await latest()
    const startTime = now + 600
    const endTime = now + 10 * DAY

    /** rate: 10,000 tokens per 1 native. */
    const rate = ETH('10000')
    const softCap = ETH('5')
    const hardCap = ETH('20')
    // What the sale must be funded with: hardCap * rate / 1e18.
    const required = ETH('200000')

    const base = {
      token: await token.getAddress(),
      startTime,
      endTime,
      softCap,
      hardCap,
      minBuy: ETH('0.01'),
      maxBuy: ETH('10'),
      rate,
      router,
      liquidityBps: 0,
      tokensForSale: required,
    }
    return { factory, token, creator, alice, bob, carol, routerC, base, now, startTime, endTime, softCap, hardCap, rate, required }
  }

  async function createSale(f: Awaited<ReturnType<typeof fixture>>, over: Record<string, unknown> = {}) {
    const tx = await as(f.factory, f.creator).createSale({ ...f.base, ...over })
    const rc = await tx.wait()
    const log = rc!.logs.map((l: any) => { try { return f.factory.interface.parseLog(l) } catch { return null } }).find(Boolean)
    return ethers.getContractAt('Presale', log.args.sale)
  }

  it('refuses a sale that cannot deliver what it promises', async () => {
    const f = await fixture()
    // 200,000 tokens needed, 199,999 offered.
    await expect(createSale(f, { tokensForSale: ETH('199999') }))
      .to.be.revertedWithCustomError(f.factory, 'Underfunded')
  })

  it('checks the funding in raw units — the only thing it can check', async () => {
    const f = await fixture()
    // The factory cannot know what a token's numbers *mean* (it would have to
    // guess at decimals), so it checks the arithmetic it can see: the sale must
    // hold at least `hardCap * rate / 1e18` raw units. A rate written for the
    // wrong decimals shows up here as an unfundable requirement, and on the
    // form, which reads `decimals()` before it builds the numbers.
    await expect(createSale(f, { tokensForSale: ETH('199999') }))
      .to.be.revertedWithCustomError(f.factory, 'Underfunded')
    const ok = await createSale(f)
    expect(await f.token.balanceOf(await ok.getAddress())).to.equal(f.required)
  })

  it('refuses windows, caps, limits and rates that are not sale-shaped', async () => {
    const f = await fixture()
    const now = await latest()
    await expect(createSale(f, { endTime: f.startTime })).to.be.revertedWithCustomError(f.factory, 'BadWindow')
    await expect(createSale(f, { endTime: now - 1 })).to.be.revertedWithCustomError(f.factory, 'BadWindow')
    await expect(createSale(f, { startTime: now - 3600 })).to.be.revertedWithCustomError(f.factory, 'StartTooFarBack')
    await expect(createSale(f, { softCap: 0 })).to.be.revertedWithCustomError(f.factory, 'BadCaps')
    await expect(createSale(f, { hardCap: ETH('1'), softCap: ETH('5') })).to.be.revertedWithCustomError(f.factory, 'BadCaps')
    await expect(createSale(f, { minBuy: 0 })).to.be.revertedWithCustomError(f.factory, 'BadLimits')
    await expect(createSale(f, { maxBuy: ETH('0.001') })).to.be.revertedWithCustomError(f.factory, 'BadLimits')
    await expect(createSale(f, { rate: 0 })).to.be.revertedWithCustomError(f.factory, 'ZeroRate')
    await expect(createSale(f, { liquidityBps: 10001 })).to.be.revertedWithCustomError(f.factory, 'BadLiquidityShare')
  })

  it('holds the tokens from the moment it exists', async () => {
    const f = await fixture()
    const sale = await createSale(f)
    expect(await f.token.balanceOf(await sale.getAddress())).to.equal(f.required)
    expect(await f.factory.saleCount()).to.equal(1n)
    expect((await f.factory.allSales())[0]).to.equal(await sale.getAddress())
  })

  it('enforces the window, the per-wallet limits and the hard cap', async () => {
    const f = await fixture()
    const sale = await createSale(f)

    await expect(as(sale, f.alice).buy({ value: ETH('1') }))
      .to.be.revertedWithCustomError(sale, 'NotStarted')

    await jumpTo(f.startTime + 1)
    await expect(as(sale, f.alice).buy({ value: ETH('0.001') }))
      .to.be.revertedWithCustomError(sale, 'BelowMinimum')
    await expect(as(sale, f.alice).buy({ value: ETH('11') }))
      .to.be.revertedWithCustomError(sale, 'AboveMaximum')

    // Fill the hard cap.
    await as(sale, f.alice).buy({ value: ETH('10') })
    await as(sale, f.bob).buy({ value: ETH('10') })
    expect(await sale.raised()).to.equal(f.hardCap)
    await expect(as(sale, f.carol).buy({ value: ETH('0.01') }))
      .to.be.revertedWithCustomError(sale, 'HardCapReached')

    await jumpTo(f.endTime + 1)
    await expect(as(sale, f.carol).buy({ value: ETH('0.01') }))
      .to.be.revertedWithCustomError(sale, 'Ended')
  })

  it('a sale that misses its soft cap refunds everyone and hands the tokens back', async () => {
    const f = await fixture()
    const sale = await createSale(f)
    await jumpTo(f.startTime + 1)
    await as(sale, f.alice).buy({ value: ETH('1') })

    // Not over yet: no refunds during the window.
    await expect(as(sale, f.alice).refund()).to.be.revertedWithCustomError(sale, 'NotEnded')

    await jumpTo(f.endTime + 1)
    // The sale failed, so the refund is the call that works — and it stays open.
    const before = await ethers.provider.getBalance(f.alice.address)
    const rc = await (await as(sale, f.alice).refund()).wait()
    const gas = rc!.gasUsed * rc!.gasPrice
    expect(await ethers.provider.getBalance(f.alice.address)).to.equal(before + ETH('1') - gas)

    // No finalize on a failed sale, and the creator gets the tokens back.
    await expect(as(sale, f.alice).finalize()).to.be.revertedWithCustomError(sale, 'SoftCapMissed')
    const creatorBefore = await f.token.balanceOf(f.creator.address)
    await as(sale, f.creator).withdrawUnsold()
    expect(await f.token.balanceOf(f.creator.address) - creatorBefore).to.equal(f.required)
  })

  it('a sale that makes its cap sends the raise to the creator and the tokens to the buyers', async () => {
    const f = await fixture()
    const sale = await createSale(f)
    await jumpTo(f.startTime + 1)
    await as(sale, f.alice).buy({ value: ETH('10') })
    await as(sale, f.bob).buy({ value: ETH('5') })

    await jumpTo(f.endTime + 1)
    // Nobody can claim before finalize.
    await expect(as(sale, f.alice).claim()).to.be.revertedWithCustomError(sale, 'NotFinalized')

    const creatorBefore = await ethers.provider.getBalance(f.creator.address)
    const rc = await (await as(sale, f.carol).finalize()).wait()
    void rc
    // Anyone may finalize; the money goes to the creator regardless, and the
    // caller pays the gas — so the creator's balance moves by exactly the raise.
    expect(await ethers.provider.getBalance(f.creator.address)).to.equal(creatorBefore + ETH('15'))
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(0n)

    await as(sale, f.alice).claim()
    await as(sale, f.bob).claim()
    expect(await f.token.balanceOf(f.alice.address)).to.equal(ETH('100000'))
    expect(await f.token.balanceOf(f.bob.address)).to.equal(ETH('50000'))
    await expect(as(sale, f.alice).claim()).to.be.revertedWithCustomError(sale, 'AlreadyClaimed')

    // Unsold tokens go back, minus what buyers can still claim (both already did).
    const creatorTokens = await f.token.balanceOf(f.creator.address)
    await as(sale, f.creator).withdrawUnsold()
    expect(await f.token.balanceOf(f.creator.address) - creatorTokens).to.equal(f.required - ETH('150000'))
  })

  it('keeps the buyers’ tokens in the contract until they claim them', async () => {
    const f = await fixture()
    const sale = await createSale(f)
    await jumpTo(f.startTime + 1)
    await as(sale, f.alice).buy({ value: ETH('10') })
    await jumpTo(f.endTime + 1)
    await as(sale, f.alice).finalize()

    // Withdrawing the "unsold" part must not touch alice's 100,000.
    await as(sale, f.creator).withdrawUnsold()
    expect(await f.token.balanceOf(await sale.getAddress())).to.equal(ETH('100000'))
    await as(sale, f.alice).claim()
    expect(await f.token.balanceOf(f.alice.address)).to.equal(ETH('100000'))
    expect(await f.token.balanceOf(await sale.getAddress())).to.equal(0n)
  })

  it('with a router: the liquidity share becomes a position owned by the creator', async () => {
    const f = await fixture({ router: true })
    const sale = await createSale(f, { router: await f.routerC!.getAddress(), liquidityBps: 6000 })
    await jumpTo(f.startTime + 1)
    await as(sale, f.alice).buy({ value: ETH('10') })

    await jumpTo(f.endTime + 1)
    const creatorBefore = await ethers.provider.getBalance(f.creator.address)
    await as(sale, f.carol).finalize()

    const router = f.routerC!
    expect(await router.lastEthAmount()).to.equal(ETH('6'))         // 60% of 10
    expect(await router.lastTokenAmount()).to.equal(ETH('60000'))   // at the sale rate
    expect(await f.token.balanceOf(await router.getAddress())).to.equal(ETH('60000'))
    // The creator gets the rest of the raise, and the contract keeps nothing.
    expect(await ethers.provider.getBalance(f.creator.address)).to.equal(creatorBefore + ETH('4'))
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(0n)
    expect(await sale.liquidityAdded()).to.equal(true)
  })

  it('a router that hands part of the deposit back does not leave it in the contract', async () => {
    const f = await fixture({ router: true })
    const sale = await createSale(f, { router: await f.routerC!.getAddress(), liquidityBps: 5000 })
    await f.routerC!.setRefund(2000)   // 20% of the ETH comes back, as a real router does
    await jumpTo(f.startTime + 1)
    await as(sale, f.alice).buy({ value: ETH('10') })

    await jumpTo(f.endTime + 1)
    const creatorBefore = await ethers.provider.getBalance(f.creator.address)
    await as(sale, f.carol).finalize()

    // 5 to liquidity, 1.0 of that returned, 5 kept — the creator receives
    // 5 (the rest of the raise) + 1 (the refund), and nothing stays behind.
    // carol paid the gas, so the creator's balance moves by exactly 6.
    expect(await ethers.provider.getBalance(f.creator.address)).to.equal(creatorBefore + ETH('6'))
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(0n)
  })

  it('reports its own status the way the page reads it', async () => {
    const f = await fixture()
    const sale = await createSale(f)
    expect(await sale.status()).to.equal('upcoming')
    await jumpTo(f.startTime + 1)
    expect(await sale.status()).to.equal('live')
    await as(sale, f.alice).buy({ value: ETH('1') })
    await jumpTo(f.endTime + 1)
    expect(await sale.status()).to.equal('failed')

    // A second sale with a window of its own (the first one's is now in the past).
    const now = await latest()
    const sale2 = await createSale(f, { startTime: now + 600, endTime: now + DAY, tokensForSale: f.required })
    await jumpTo(now + 601)
    await as(sale2, f.alice).buy({ value: ETH('10') })
    await jumpTo(now + DAY + 1)
    expect(await sale2.status()).to.equal('ended, awaiting finalize')
    await as(sale2, f.alice).finalize()
    expect(await sale2.status()).to.equal('finalized')
  })
})
