import { expect } from 'chai'
import { ethers } from 'hardhat'
import { as, jumpTo } from './helpers'
import type { Contract } from 'ethers'

/** Flap-style buy/sell tax, bucket split and the 0.06%-of-volume commission. */
describe('OakenTaxToken', () => {
  const SUPPLY = ethers.parseEther('1000000000')
  const DURATION = 3600

  async function fixture() {
    const [factory, graduator, creator, curve, pool, alice, marketing, dividend, liquidity, protocol] =
      await ethers.getSigners()
    const token: Contract = await ethers.deployContract('OakenTaxToken', [[
      'Tax Token',
      'TAX',
      SUPPLY,
      curve.address,
      factory.address,
      graduator.address,
      creator.address,
      [500, 500, DURATION, 4000, 2000, 2000, 2000, marketing.address, dividend.address, liquidity.address, protocol.address],
    ]])
    return { token, factory, graduator, creator, curve, pool, alice, marketing, dividend, liquidity, protocol }
  }

  it('mints the whole supply to the curve and exempts the system addresses', async () => {
    const { token, curve, factory, graduator, creator, marketing, protocol } = await fixture()
    expect(await token.totalSupply()).to.equal(SUPPLY)
    expect(await token.balanceOf(curve.address)).to.equal(SUPPLY)
    for (const a of [curve.address, factory.address, graduator.address, creator.address, marketing.address, protocol.address]) {
      expect(await token.exempt(a)).to.equal(true)
    }
    expect(await token.taxStart()).to.equal(0n)
  })

  it('only the factory or the graduator can register a pool', async () => {
    const { token, factory, graduator, pool, alice } = await fixture()
    await expect(as(token, alice).setPool(pool.address, true)).to.be.revertedWithCustomError(token, 'NotPoolAuthority')
    await as(token, graduator).setPool(pool.address, true)
    expect(await token.isPool(pool.address)).to.equal(true)
    expect(await token.taxStart()).to.be.greaterThan(0n)
    await as(token, factory).setPool(pool.address, false)
    expect(await token.isPool(pool.address)).to.equal(false)
  })

  it('takes the buy tax on pool → buyer and splits it into the four buckets', async () => {
    const { token, factory, curve, pool, alice, marketing, dividend, liquidity, protocol } = await fixture()
    await as(token, factory).setPool(pool.address, true)
    await as(token, curve).transfer(pool.address, ethers.parseEther('10000'))

    const amount = ethers.parseEther('1000')
    await as(token, pool).transfer(alice.address, amount)

    const tax = (amount * 500n) / 10000n // 5%
    const commission = (tax * (60000n / 500n)) / 10000n // 0.06% of volume
    const rest = tax - commission
    const mkt = (rest * 4000n) / 10000n
    const def = (rest * 2000n) / 10000n
    const div = (rest * 2000n) / 10000n
    const liq = rest - mkt - def - div

    expect(await token.balanceOf(alice.address)).to.equal(amount - tax)
    expect(await token.balanceOf(protocol.address)).to.equal(commission)
    expect(await token.balanceOf(marketing.address)).to.equal(mkt)
    expect(await token.balanceOf(dividend.address)).to.equal(div)
    expect(await token.balanceOf(liquidity.address)).to.equal(liq)
    expect(await token.balanceOf(token.BURN())).to.equal(def)
  })

  it('takes the sell tax on user → pool', async () => {
    const { token, factory, curve, pool, alice } = await fixture()
    await as(token, factory).setPool(pool.address, true)
    await as(token, curve).transfer(alice.address, ethers.parseEther('1000'))
    const before = await token.balanceOf(pool.address)
    await as(token, alice).transfer(pool.address, ethers.parseEther('100'))
    expect(await token.balanceOf(pool.address)).to.equal(before + ethers.parseEther('95'))
  })

  it('charges nothing outside the window or for exempt wallets', async () => {
    const { token, factory, curve, pool, creator, alice } = await fixture()
    await as(token, factory).setPool(pool.address, true)
    await as(token, curve).transfer(creator.address, ethers.parseEther('100'))
    // Creator is exempt even when sending into the pool.
    const p0 = await token.balanceOf(pool.address)
    await as(token, creator).transfer(pool.address, ethers.parseEther('100'))
    expect(await token.balanceOf(pool.address)).to.equal(p0 + ethers.parseEther('100'))

    // After the window, a pool → buyer transfer pays no tax.
    const start = await token.taxStart()
    await jumpTo(Number(start) + DURATION + 5)
    await as(token, curve).transfer(pool.address, ethers.parseEther('1000'))
    const a0 = await token.balanceOf(alice.address)
    await as(token, pool).transfer(alice.address, ethers.parseEther('100'))
    expect(await token.balanceOf(alice.address)).to.equal(a0 + ethers.parseEther('100'))
    expect(await token.taxActive()).to.equal(false)
  })

  it('does not tax ordinary wallet-to-wallet transfers', async () => {
    const { token, factory, pool, alice, curve } = await fixture()
    const [, , , , , , , , , , bob] = await ethers.getSigners()
    await as(token, factory).setPool(pool.address, true)
    await as(token, curve).transfer(alice.address, ethers.parseEther('1000'))
    const before = await token.balanceOf(alice.address)
    await as(token, alice).transfer(bob.address, ethers.parseEther('100'))
    expect(await token.balanceOf(alice.address)).to.equal(before - ethers.parseEther('100'))
    expect(await token.balanceOf(bob.address)).to.equal(ethers.parseEther('100'))
  })
})
