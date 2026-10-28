import { expect } from 'chai'
import { ethers } from 'hardhat'
import { as, loadFixture, latest, jumpTo } from './helpers'
import type { Contract } from 'ethers'

/**
 * OAKEN Curve, Pons-model launch on an EVM chain.
 *
 * The assertions are about properties, not just happy paths: the whole supply
 * starts in the curve, the creator gets nothing, fees are split exactly, the
 * snipe tax decays, a capped buy refunds the excess, and graduation transfers
 * the reserved allocation once and closes trading.
 */
describe('OakenCurve (Pons model)', () => {
  const SUPPLY = ethers.parseEther('1000000000')
  const PHANTOM = ethers.parseEther('1.68')
  const THRESHOLD = ethers.parseEther('4.2')
  const FEE_BPS = 100n
  const RESERVED = (SUPPLY * PHANTOM) / (PHANTOM + THRESHOLD)

  async function fixture() {
    const [creator, protocol, alice, bob] = await ethers.getSigners()
    const graduator: Contract = await ethers.deployContract('MockCurveGraduator')
    const factory: Contract = await ethers.deployContract('OakenCurveFactory', [[
      SUPPLY,
      0n, // no virtual token reserve (Pons model)
      PHANTOM,
      THRESHOLD,
      FEE_BPS,
      1000n, // maxCreatorTaxBps
      0n, // protocolShareBps
      9900n, // snipeTaxStartBps
      3n, // snipeTaxSeconds
      protocol.address,
      graduator.target,
      protocol.address,
      0n, // launchFee
    ]])
    const salt = ethers.hexlify(ethers.randomBytes(32))
    const name = 'Oaken Curve Test'
    const symbol = 'OCT'
    const tx = await as(factory, creator).createLaunch({
      name,
      symbol,
      creatorFeeRecipient: creator.address,
      creatorTaxBps: 0,
      salt,
      snipeTaxExempt: [],
    })
    const rc = await tx.wait()
    const ev = rc!.logs
      .map((l: any) => { try { return factory.interface.parseLog(l) } catch { return null } })
      .find((e: any) => e?.name === 'LaunchCreated')
    const token = await ethers.getContractAt('OakenToken', ev.args.token)
    const curve = await ethers.getContractAt('OakenCurve', ev.args.curve)
    return { factory, graduator, token, curve, creator, protocol, alice, bob, salt, name, symbol }
  }

  it('mints the whole supply to the curve and none to the creator', async () => {
    const { token, curve, creator, graduator } = await loadFixture(fixture)
    expect(await token.totalSupply()).to.equal(SUPPLY)
    expect(await token.balanceOf(curve.target)).to.equal(SUPPLY)
    expect(await token.balanceOf(creator.address)).to.equal(0n)
    expect(await curve.reservedTokens()).to.equal(RESERVED)
    expect(await curve.launchSupply()).to.equal(SUPPLY)
    expect(await curve.readyToGraduate()).to.equal(false)
    // The graduation pool is fixed at launch, at the exact amounts it will receive.
    expect(await graduator.initCalls()).to.equal(1n)
    expect(await graduator.initQuoteAmount()).to.equal(THRESHOLD)
    expect(await graduator.initTokenAmount()).to.equal(RESERVED)
  })

  it('charges the 1% base fee on a buy and moves the price', async () => {
    const { curve, token, creator } = await loadFixture(fixture)
    const before = await curve.getReserves()
    const value = ethers.parseEther('1')
    const tx = await as(curve, creator).buy(0, creator.address, { value })
    const rc = await tx.wait()
    const ev = rc!.logs
      .map((l: any) => { try { return curve.interface.parseLog(l) } catch { return null } })
      .find((e: any) => e?.name === 'Bought')

    expect(ev.args.fee).to.equal((value * FEE_BPS) / 10000n)
    expect(ev.args.snipeTax).to.equal(0n) // creator is exempt
    expect(await curve.trackedQuote()).to.equal(value - ev.args.fee)
    expect(await curve.creatorFeeBalance()).to.equal(ev.args.fee)
    expect(await token.balanceOf(creator.address)).to.equal(ev.args.tokensOut)
    expect(ev.args.tokensOut).to.be.greaterThan(0n)

    const after = await curve.getReserves()
    expect(after[0]).to.be.greaterThan(before[0])
    expect(after[1]).to.be.lessThan(before[1])
  })

  it('charges the snipe tax on non-exempt buyers and lets it expire', async () => {
    const { curve, alice } = await loadFixture(fixture)
    const value = ethers.parseEther('1')

    const tx1 = await as(curve, alice).buy(0, alice.address, { value })
    const rc1 = await tx1.wait()
    const ev1 = rc1!.logs
      .map((l: any) => { try { return curve.interface.parseLog(l) } catch { return null } })
      .find((e: any) => e?.name === 'Bought')
    // The buy lands one second after launch: 9900 >> ((1 * 14) / 3) = 618 bps.
    expect(ev1.args.snipeTax).to.equal((value * 618n) / 10000n)
    expect(await curve.snipeTaxBalance()).to.equal(ev1.args.snipeTax)

    await jumpTo((await latest()) + 4)
    const tx2 = await as(curve, alice).buy(0, alice.address, { value })
    const rc2 = await tx2.wait()
    const ev2 = rc2!.logs
      .map((l: any) => { try { return curve.interface.parseLog(l) } catch { return null } })
      .find((e: any) => e?.name === 'Bought')
    expect(ev2.args.snipeTax).to.equal(0n)
  })

  it('sells back into the curve and charges the fee on the quote leg', async () => {
    const { curve, token, creator } = await loadFixture(fixture)
    await as(curve, creator).buy(0, creator.address, { value: ethers.parseEther('1') })
    const held = await token.balanceOf(creator.address)
    const half = held / 2n
    await as(token, creator).approve(curve.target, half)

    const before = await curve.creatorFeeBalance()
    const tx = await as(curve, creator).sell(half, 0, creator.address)
    const rc = await tx.wait()
    const ev = rc!.logs
      .map((l: any) => { try { return curve.interface.parseLog(l) } catch { return null } })
      .find((e: any) => e?.name === 'Sold')
    expect(ev.args.quoteOut).to.be.greaterThan(0n)
    expect(ev.args.fee).to.be.greaterThan(0n)
    expect(await curve.creatorFeeBalance()).to.be.greaterThan(before)
    expect(await token.balanceOf(creator.address)).to.equal(held - half)
  })

  it('caps a buy at the sellable allocation, refunds the excess, and graduates once', async () => {
    const { curve, token, graduator, creator, alice } = await loadFixture(fixture)
    const value = ethers.parseEther('5')
    const tx = await as(curve, creator).buy(0, creator.address, { value })
    const rc = await tx.wait()
    const ev = rc!.logs
      .map((l: any) => { try { return curve.interface.parseLog(l) } catch { return null } })
      .find((e: any) => e?.name === 'Bought')
    expect(ev.args.tokensOut).to.equal(SUPPLY - RESERVED)
    expect(ev.args.quoteIn).to.be.lessThan(value) // the excess was refunded
    expect(await curve.readyToGraduate()).to.equal(true)
    expect(await curve.trackedTokens()).to.equal(RESERVED)

    // Ready but not yet graduated: a buy cannot enter the reserved slice.
    await expect(as(curve, alice).buy(0, alice.address, { value: 1n }))
      .to.be.revertedWithCustomError(curve, 'CurveComplete')

    const quoteToPool = await curve.trackedQuote()
    await as(curve, alice).graduate()
    expect(await curve.graduated()).to.equal(true)
    expect(await graduator.calls()).to.equal(1n)
    expect(await graduator.lastToken()).to.equal(token.target)
    expect(await graduator.lastTokenAmount()).to.equal(RESERVED)
    expect(await graduator.lastQuoteAmount()).to.equal(quoteToPool)
    expect(await token.balanceOf(graduator.target)).to.equal(RESERVED)
    expect(await ethers.provider.getBalance(graduator.target)).to.equal(quoteToPool)

    await expect(as(curve, alice).buy(0, alice.address, { value: 1n }))
      .to.be.revertedWithCustomError(curve, 'GraduatedError')
    await expect(as(curve, alice).graduate()).to.be.revertedWithCustomError(curve, 'GraduatedError')
  })

  it('lets only the creator recipient sweep creator fees after graduation', async () => {
    const { curve, creator, alice } = await loadFixture(fixture)
    await as(curve, creator).buy(0, creator.address, { value: ethers.parseEther('5') })
    await as(curve, alice).graduate()
    const pending = await curve.pendingCreatorFees()
    expect(pending).to.be.greaterThan(0n)
    await expect(as(curve, alice).sweepCreatorFees()).to.be.revertedWithCustomError(curve, 'NotCreatorRecipient')
    await as(curve, creator).sweepCreatorFees()
    expect(await curve.pendingCreatorFees()).to.equal(0n)
  })

  it('splits the base fee with the protocol when protocolShareBps is non-zero', async () => {
    const [creator, protocol, alice] = await ethers.getSigners()
    const graduator: Contract = await ethers.deployContract('MockCurveGraduator')
    const factory: Contract = await ethers.deployContract('OakenCurveFactory', [[
      SUPPLY, 0n, PHANTOM, THRESHOLD, FEE_BPS, 1000n,
      5000n, // 50% to the protocol
      9900n, 3n, protocol.address, graduator.target, protocol.address, 0n,
    ]])
    const tx = await as(factory, creator).createLaunch({
      name: 'Split Test', symbol: 'SPLIT', creatorFeeRecipient: creator.address,
      creatorTaxBps: 0, salt: ethers.hexlify(ethers.randomBytes(32)), snipeTaxExempt: [],
    })
    const ev = (await tx.wait())!.logs
      .map((l: any) => { try { return factory.interface.parseLog(l) } catch { return null } })
      .find((e: any) => e?.name === 'LaunchCreated')
    const curve = await ethers.getContractAt('OakenCurve', ev.args.curve)

    await as(curve, creator).buy(0, creator.address, { value: ethers.parseEther('1') })
    const fee = (ethers.parseEther('1') * FEE_BPS) / 10000n
    expect(await curve.protocolFeeBalance()).to.equal(fee / 2n)
    expect(await curve.creatorFeeBalance()).to.equal(fee - fee / 2n)
    await expect(as(curve, alice).sweepProtocolFees()).to.be.revertedWithCustomError(curve, 'NotProtocolRecipient')
    await as(curve, protocol).sweepProtocolFees()
    expect(await curve.protocolFeeBalance()).to.equal(0n)
  })

  it('enforces the factory limits on chain', async () => {
    const { factory, creator } = await loadFixture(fixture)
    const base = {
      name: 'X', symbol: 'X', creatorFeeRecipient: creator.address,
      creatorTaxBps: 0, salt: ethers.hexlify(ethers.randomBytes(32)), snipeTaxExempt: [],
    }
    await expect(as(factory, creator).createLaunch({ ...base, creatorTaxBps: 1001 }))
      .to.be.revertedWithCustomError(factory, 'CreatorTaxTooHigh')
    await expect(as(factory, creator).createLaunch({ ...base, name: '' }))
      .to.be.revertedWithCustomError(factory, 'InvalidName')
    await expect(as(factory, creator).createLaunch({ ...base, symbol: '' }))
      .to.be.revertedWithCustomError(factory, 'InvalidSymbol')
    await expect(as(factory, creator).createLaunch({
      ...base, snipeTaxExempt: Array.from({ length: 33 }, () => creator.address),
    })).to.be.revertedWithCustomError(factory, 'TooManyExemptions')

    // A duplicate salt with the same arguments cannot overwrite the first launch.
    await as(factory, creator).createLaunch(base)
    await expect(as(factory, creator).createLaunch(base)).to.be.reverted
  })

  it('keeps the supply constant across buys, sells and graduation', async () => {
    const { curve, token, graduator, creator, alice } = await loadFixture(fixture)
    await as(curve, creator).buy(0, creator.address, { value: ethers.parseEther('0.5') })
    const held = await token.balanceOf(creator.address)
    await as(token, creator).approve(curve.target, held / 2n)
    await as(curve, creator).sell(held / 2n, 0, creator.address)
    await as(curve, creator).buy(0, creator.address, { value: ethers.parseEther('5') })

    const sum1 = (await token.balanceOf(curve.target)) + (await token.balanceOf(creator.address))
      + (await token.balanceOf(alice.address)) + (await token.balanceOf(graduator.target))
    expect(sum1).to.equal(SUPPLY)

    await as(curve, alice).graduate()
    const sum2 = (await token.balanceOf(curve.target)) + (await token.balanceOf(creator.address))
      + (await token.balanceOf(alice.address)) + (await token.balanceOf(graduator.target))
    expect(sum2).to.equal(SUPPLY)
  })
})
