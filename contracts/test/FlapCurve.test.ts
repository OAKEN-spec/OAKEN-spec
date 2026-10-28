import { expect } from 'chai'
import { ethers } from 'hardhat'
import { as, loadFixture } from './helpers'
import type { Contract } from 'ethers'

/**
 * BNB Chain (56) — Flap-model curve and tax-token launches.
 *
 * Numbers come from Flap's latest BSC curve: r = 6.14 BNB, h = 107,036,752
 * tokens, graduation at 800M sold / ~16 BNB reserve.
 */
describe('OakenFlapCurveFactory (56)', () => {
  const SUPPLY = ethers.parseEther('1000000000')
  const H = ethers.parseEther('107036752')
  const R = ethers.parseEther('6.14')
  const THRESHOLD = ethers.parseEther('16')
  const FEE_BPS = 100n
  const RESERVED = ((SUPPLY + H) * R) / (R + THRESHOLD) - H
  const SELLABLE = SUPPLY - RESERVED
  const ZERO = ethers.ZeroAddress

  const taxParams = (over: Partial<Record<string, unknown>> = {}) => ({
    buyTaxBps: 500,
    sellTaxBps: 500,
    taxDuration: 3600,
    marketingBps: 4000,
    deflationBps: 2000,
    dividendBps: 2000,
    liquidityBps: 2000,
    marketingWallet: ZERO,
    dividendWallet: ZERO,
    liquidityWallet: ZERO,
    ...over,
  })

  async function fixture() {
    const [deployer, protocol, creator, alice, bob] = await ethers.getSigners()
    const stdGrad: Contract = await ethers.deployContract('MockCurveGraduator')
    const taxGrad: Contract = await ethers.deployContract('MockCurveGraduator')
    const tokenDeployer: Contract = await ethers.deployContract('OakenFlapTokenDeployer', [deployer.address])
    const factory: Contract = await ethers.deployContract('OakenFlapCurveFactory', [[
      SUPPLY,
      H,
      R,
      THRESHOLD,
      FEE_BPS,
      1000n, // max creator tax
      600n, // protocol share: 6% of the 1% fee = 0.06% of volume
      9900n,
      3n,
      protocol.address,
      stdGrad.target,
      taxGrad.target,
      tokenDeployer.target,
      protocol.address,
      0n, // launch fee
    ]])
    await as(tokenDeployer, deployer).bindFactory(factory.target)
    return { factory, stdGrad, taxGrad, tokenDeployer, deployer, protocol, creator, alice, bob }
  }

  const standardLaunch = (creator: string, salt: string) => [
    'Flap Standard', 'FS', creator, 0, salt, [], false,
    [0, 0, 0, 0, 0, 0, 0, ZERO, ZERO, ZERO],
  ]

  it('mints the fixed supply to the curve and reserves exactly 200M for the pool', async () => {
    const { factory, creator } = await loadFixture(fixture)
    const salt = ethers.hexlify(ethers.randomBytes(32))
    const tx = await as(factory, creator).createLaunch(standardLaunch(creator.address, salt))
    const ev = (await tx.wait())!.logs
      .map((l: any) => { try { return factory.interface.parseLog(l) } catch { return null } })
      .find((e: any) => e?.name === 'LaunchCreated')
    const token: Contract = await ethers.getContractAt('OakenToken', ev.args.token)
    const curve: Contract = await ethers.getContractAt('OakenCurve', ev.args.curve)
    expect(await token.totalSupply()).to.equal(SUPPLY)
    expect(await token.balanceOf(curve.target)).to.equal(SUPPLY)
    expect(await token.balanceOf(creator.address)).to.equal(0n)
    expect(await curve.virtualTokens()).to.equal(H)
    expect(await curve.phantomQuote()).to.equal(R)
    expect(await curve.reservedTokens()).to.equal(RESERVED)
    expect(await curve.graduationThreshold()).to.equal(THRESHOLD)
    expect(await ev.args.tax).to.equal(false)
  })

  it('sells 800M on the curve and makes ~16 BNB before graduation', async () => {
    const { factory, stdGrad, creator } = await loadFixture(fixture)
    const salt = ethers.hexlify(ethers.randomBytes(32))
    const tx = await as(factory, creator).createLaunch(standardLaunch(creator.address, salt))
    const ev = (await tx.wait())!.logs
      .map((l: any) => { try { return factory.interface.parseLog(l) } catch { return null } })
      .find((e: any) => e?.name === 'LaunchCreated')
    const token: Contract = await ethers.getContractAt('OakenToken', ev.args.token)
    const curve: Contract = await ethers.getContractAt('OakenCurve', ev.args.curve)

    const buy = await as(curve, creator).buy(0, creator.address, { value: ethers.parseEther('20') })
    const bought = (await buy.wait())!.logs
      .map((l: any) => { try { return curve.interface.parseLog(l) } catch { return null } })
      .find((e: any) => e?.name === 'Bought')
    expect(bought.args.tokensOut).to.equal(SELLABLE)
    expect(await token.balanceOf(creator.address)).to.equal(SELLABLE)
    expect(await curve.readyToGraduate()).to.equal(true)
    expect(await curve.trackedTokens()).to.equal(RESERVED)
    const raised = await curve.trackedQuote()
    const diff = raised > THRESHOLD ? raised - THRESHOLD : THRESHOLD - raised
    expect(diff).to.be.lessThan(ethers.parseEther('0.0001'))
    expect(bought.args.quoteIn).to.be.lessThan(ethers.parseEther('20'))
  })

  it('a sell grows the real reserve only by the tokens returned, not by h', async () => {
    const { factory, creator } = await loadFixture(fixture)
    const salt = ethers.hexlify(ethers.randomBytes(32))
    const tx = await as(factory, creator).createLaunch(standardLaunch(creator.address, salt))
    const ev = (await tx.wait())!.logs
      .map((l: any) => { try { return factory.interface.parseLog(l) } catch { return null } })
      .find((e: any) => e?.name === 'LaunchCreated')
    const token: Contract = await ethers.getContractAt('OakenToken', ev.args.token)
    const curve: Contract = await ethers.getContractAt('OakenCurve', ev.args.curve)

    await as(curve, creator).buy(0, creator.address, { value: ethers.parseEther('1') })
    const held = await token.balanceOf(creator.address)
    const half = held / 2n
    const before = await curve.trackedTokens()
    await as(token, creator).approve(curve.target, half)
    await as(curve, creator).sell(half, 0, creator.address)
    // The virtual token reserve is for pricing only; it must never enter the
    // real reserve, or the curve could sell into the reserved graduation slice.
    expect(await curve.trackedTokens()).to.equal(before + half)
    expect(await token.balanceOf(curve.target)).to.equal(await curve.trackedTokens())
    expect(await curve.reservedTokens()).to.equal(RESERVED)
  })

  it('graduates into the graduator exactly once and closes the curve', async () => {
    const { factory, stdGrad, creator, alice } = await loadFixture(fixture)
    const salt = ethers.hexlify(ethers.randomBytes(32))
    const tx = await as(factory, creator).createLaunch(standardLaunch(creator.address, salt))
    const ev = (await tx.wait())!.logs
      .map((l: any) => { try { return factory.interface.parseLog(l) } catch { return null } })
      .find((e: any) => e?.name === 'LaunchCreated')
    const token: Contract = await ethers.getContractAt('OakenToken', ev.args.token)
    const curve: Contract = await ethers.getContractAt('OakenCurve', ev.args.curve)
    await as(curve, creator).buy(0, creator.address, { value: ethers.parseEther('20') })
    const quoteToPool = await curve.trackedQuote()
    await as(curve, alice).graduate()
    expect(await curve.graduated()).to.equal(true)
    expect(await stdGrad.calls()).to.equal(1n)
    expect(await stdGrad.lastTokenAmount()).to.equal(RESERVED)
    expect(await stdGrad.lastQuoteAmount()).to.equal(quoteToPool)
    expect(await token.balanceOf(stdGrad.target)).to.equal(RESERVED)
    await expect(as(curve, alice).graduate()).to.be.revertedWithCustomError(curve, 'GraduatedError')
  })

  it('creates a tax launch with the configured rates, buckets and wallets', async () => {
    const { factory, creator, protocol } = await loadFixture(fixture)
    const salt = ethers.hexlify(ethers.randomBytes(32))
    const launch = [
      'Flap Tax', 'FT', creator.address, 0, salt, [], true,
      [500, 500, 3600, 4000, 2000, 2000, 2000, creator.address, creator.address, creator.address],
    ]
    const tx = await as(factory, creator).createLaunch(launch)
    const ev = (await tx.wait())!.logs
      .map((l: any) => { try { return factory.interface.parseLog(l) } catch { return null } })
      .find((e: any) => e?.name === 'LaunchCreated')
    const token: Contract = await ethers.getContractAt('OakenTaxToken', ev.args.token)
    const curve: Contract = await ethers.getContractAt('OakenCurve', ev.args.curve)
    expect(await ev.args.tax).to.equal(true)
    expect(await token.totalSupply()).to.equal(SUPPLY)
    expect(await token.balanceOf(curve.target)).to.equal(SUPPLY)
    const tax = await token.tax()
    expect(tax.buyTaxBps).to.equal(500n)
    expect(tax.sellTaxBps).to.equal(500n)
    expect(tax.commissionReceiver).to.equal(protocol.address)
    expect(await token.exempt(curve.target)).to.equal(true)
    expect(await token.exempt(creator.address)).to.equal(true)
    expect(await token.taxStart()).to.equal(0n)
    // The treasury wallets are exempt from the snipe tax on the curve.
    expect(await curve.snipeTaxExempt(creator.address)).to.equal(true)
  })

  it('rejects tax rates and bucket totals outside Flap settings', async () => {
    const { factory, creator } = await loadFixture(fixture)
    const base = (tax: unknown[]) => [
      'Bad Tax', 'BT', creator.address, 0, ethers.hexlify(ethers.randomBytes(32)), [], true, tax,
    ]
    const taxAbi = await ethers.getContractFactory('OakenTaxToken')
    await expect(as(factory, creator).createLaunch(base([200, 500, 3600, 4000, 2000, 2000, 2000, ZERO, ZERO, ZERO])))
      .to.be.revertedWithCustomError(taxAbi, 'InvalidTaxRate')
    await expect(as(factory, creator).createLaunch(base([500, 500, 3600, 3000, 2000, 2000, 2000, ZERO, ZERO, ZERO])))
      .to.be.revertedWithCustomError(taxAbi, 'InvalidBuckets')
  })

  it('enforces creator tax, name and salt limits', async () => {
    const { factory, creator } = await loadFixture(fixture)
    const salt = ethers.hexlify(ethers.randomBytes(32))
    const p = standardLaunch(creator.address, salt)
    await expect(as(factory, creator).createLaunch([p[0], p[1], p[2], 1001, p[4], p[5], p[6], p[7]]))
      .to.be.revertedWithCustomError(factory, 'CreatorTaxTooHigh')
    await expect(as(factory, creator).createLaunch(['', p[1], p[2], p[3], p[4], p[5], p[6], p[7]]))
      .to.be.revertedWithCustomError(factory, 'InvalidName')
    await as(factory, creator).createLaunch(p)
    await expect(as(factory, creator).createLaunch(p)).to.be.reverted
  })
})
