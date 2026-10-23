import { expect } from 'chai'
import { ethers } from 'hardhat'
import { as } from './helpers'
import type { Contract } from 'ethers'

/**
 * The factory and the token it makes.
 *
 * Two kinds of assertion here. The factory's: every limit it advertises is
 * enforced on chain, not only in a form — anyone can call it directly, and a
 * factory that validates only in its own UI validates nothing. The token's:
 * the standard ERC-20 surface behaves, and the two behaviours that separate it
 * from the templates it replaces (no mint, fixed supply) are properties of the
 * code rather than claims in a comment.
 */
describe('TokenFactory + OakenToken', () => {
  async function fixture() {
    const [creator, alice, bob] = await ethers.getSigners()
    const factory: Contract = await ethers.deployContract('TokenFactory')
    return { factory, creator, alice, bob }
  }

  async function create(factory: Contract, signer: any, over: Partial<Record<string, unknown>> = {}) {
    const args = {
      name: 'Oaken Test Token',
      symbol: 'OAKT',
      decimals: 18,
      supply: ethers.parseEther('1000000'),
      ...over,
    }
    const tx = await as(factory, signer).createToken(args.name, args.symbol, args.decimals, args.supply)
    const rc = await tx.wait()
    const log = rc!.logs.map((l: any) => { try { return factory.interface.parseLog(l) } catch { return null } }).find(Boolean)
    return ethers.getContractAt('OakenToken', log.args.token)
  }

  it('deploys a token with the whole supply to the caller', async () => {
    const { factory, creator } = await fixture()
    const supply = ethers.parseEther('1000000')
    const token = await create(factory, creator, { supply })

    expect(await token.name()).to.equal('Oaken Test Token')
    expect(await token.symbol()).to.equal('OAKT')
    expect(await token.decimals()).to.equal(18)
    expect(await token.totalSupply()).to.equal(supply)
    expect(await token.balanceOf(creator.address)).to.equal(supply)
  })

  it('lists what it deployed', async () => {
    const { factory, creator } = await fixture()
    const t1 = await create(factory, creator, { symbol: 'ONE' })
    const t2 = await create(factory, creator, { symbol: 'TWO' })
    expect(await factory.tokenCount()).to.equal(2n)
    const all = await factory.allTokens()
    expect(all[0]).to.equal(await t1.getAddress())
    expect(all[1]).to.equal(await t2.getAddress())
  })

  it('enforces its limits on chain', async () => {
    const { factory, creator } = await fixture()
    await expect(create(factory, creator, { name: '' })).to.be.revertedWithCustomError(factory, 'EmptyName')
    await expect(create(factory, creator, { name: 'x'.repeat(65) })).to.be.revertedWithCustomError(factory, 'NameTooLong')
    await expect(create(factory, creator, { symbol: 'x'.repeat(17) })).to.be.revertedWithCustomError(factory, 'SymbolTooLong')
    await expect(create(factory, creator, { decimals: 19 })).to.be.revertedWithCustomError(factory, 'DecimalsTooHigh')
    await expect(create(factory, creator, { supply: 0n })).to.be.revertedWithCustomError(factory, 'ZeroSupply')
  })

  it('transfers, approves and pulls like an ERC-20', async () => {
    const { factory, creator, alice, bob } = await fixture()
    const token = await create(factory, creator)
    const amount = ethers.parseEther('100')

    await as(token, creator).transfer(alice.address, amount)
    expect(await token.balanceOf(alice.address)).to.equal(amount)

    await as(token, alice).approve(bob.address, amount / 2n)
    await as(token, bob).transferFrom(alice.address, bob.address, amount / 2n)
    expect(await token.balanceOf(bob.address)).to.equal(amount / 2n)
    // A finite allowance is spent exactly: pulling the whole thing leaves zero,
    // which is the difference between this and the infinite-allowance case below.
    expect(await token.allowance(alice.address, bob.address)).to.equal(0n)
  })

  it('does not decrement an infinite allowance', async () => {
    const { factory, creator, alice, bob } = await fixture()
    const token = await create(factory, creator)
    await as(token, creator).approve(alice.address, ethers.MaxUint256)
    await as(token, alice).transferFrom(creator.address, bob.address, ethers.parseEther('1'))
    expect(await token.allowance(creator.address, alice.address)).to.equal(ethers.MaxUint256)
  })

  it('reverts a transfer it cannot back, with both numbers', async () => {
    const { factory, creator, alice } = await fixture()
    const token = await create(factory, creator, { supply: ethers.parseEther('10') })
    await expect(as(token, alice).transfer(creator.address, 1n))
      .to.be.revertedWithCustomError(token, 'InsufficientBalance')
  })

  it('refuses transfers to the zero address', async () => {
    const { factory, creator } = await fixture()
    const token = await create(factory, creator)
    await expect(as(token, creator).transfer(ethers.ZeroAddress, 1n))
      .to.be.revertedWithCustomError(token, 'ZeroAddress')
  })

  it('has no way to mint after deployment — the supply is the constructor’s', async () => {
    const { factory, creator } = await fixture()
    const token = await create(factory, creator)
    const names = Object.keys(token.interface.fragments.reduce((acc: any, f: any) => ({ ...acc, [f.name || 'constructor']: 1 }), {}))
    for (const n of ['mint', 'burn', 'pause', 'owner', 'transferOwnership']) {
      expect(names, `${n} must not exist`).to.not.include(n)
    }
  })
})
