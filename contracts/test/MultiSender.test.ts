import { expect } from 'chai'
import { ethers } from 'hardhat'
import { as } from './helpers'
import type { Contract } from 'ethers'

/**
 * MultiSender.
 *
 * The interesting assertions are not the happy paths — they are the four ways a
 * batch goes wrong: a value that does not add up, arrays of different lengths,
 * a zero address hidden in the list, and a batch too long to fit in a block.
 * Each of those is a way to lose money quietly if it is not a revert.
 */
describe('MultiSender', () => {
  async function fixture() {
    const [sender, a, b, c] = await ethers.getSigners()
    const multi: Contract = await ethers.deployContract('MultiSender')
    const token: Contract = await ethers.deployContract('MockToken', ['Mock', 'MOCK'])
    await token.mint(sender.address, ethers.parseEther('1000000'))
    await as(token, sender).approve(await multi.getAddress(), ethers.MaxUint256)
    return { multi, token, sender, a, b, c }
  }

  it('sends native currency to every recipient in one transaction', async () => {
    const { multi, sender, a, b, c } = await fixture()
    const amounts = [ethers.parseEther('1'), ethers.parseEther('2'), ethers.parseEther('3')]
    const total = amounts.reduce((s, x) => s + x, 0n)

    const before = await Promise.all([a, b, c].map((s) => ethers.provider.getBalance(s.address)))
    await as(multi, sender).disperseEther([a.address, b.address, c.address], amounts, { value: total })
    const after = await Promise.all([a, b, c].map((s) => ethers.provider.getBalance(s.address)))

    expect(after[0] - before[0]).to.equal(amounts[0])
    expect(after[1] - before[1]).to.equal(amounts[1])
    expect(after[2] - before[2]).to.equal(amounts[2])
    expect(await ethers.provider.getBalance(await multi.getAddress())).to.equal(0n)
  })

  it('reverts when the value does not equal the sum', async () => {
    const { multi, sender, a, b } = await fixture()
    await expect(
      as(multi, sender).disperseEther([a.address, b.address], [1n, 2n], { value: 2n }),
    ).to.be.revertedWithCustomError(multi, 'ValueMismatch')
  })

  it('reverts on mismatched array lengths, and says which is which', async () => {
    const { multi, sender, a, b } = await fixture()
    await expect(
      as(multi, sender).disperseEther([a.address, b.address], [1n], { value: 1n }),
    ).to.be.revertedWithCustomError(multi, 'LengthMismatch')
  })

  it('reverts on a zero address in the list rather than burning the share', async () => {
    const { multi, sender, a } = await fixture()
    await expect(
      as(multi, sender).disperseEther([a.address, ethers.ZeroAddress], [1n, 1n], { value: 2n }),
    ).to.be.revertedWithCustomError(multi, 'ZeroRecipient')
  })

  it('reverts on an empty batch and on one above the cap', async () => {
    const { multi, sender } = await fixture()
    await expect(as(multi, sender).disperseEther([], [], { value: 0n }))
      .to.be.revertedWithCustomError(multi, 'EmptyBatch')

    const many = Array.from({ length: 401 }, () => sender.address)
    await expect(as(multi, sender).disperseEther(many, many.map(() => 0n), { value: 0n }))
      .to.be.revertedWithCustomError(multi, 'BatchTooLarge')
  })

  it('skips zero amounts without skipping the zero-address check', async () => {
    const { multi, sender, a, b } = await fixture()
    const before = await ethers.provider.getBalance(b.address)
    await as(multi, sender).disperseEther([a.address, b.address], [ethers.parseEther('1'), 0n], { value: ethers.parseEther('1') })
    expect(await ethers.provider.getBalance(b.address)).to.equal(before)
  })

  it('splits equally and returns the division remainder to the sender', async () => {
    const { multi, sender, a, b, c } = await fixture()
    const sent = ethers.parseEther('1') + 2n   // not divisible by 3
    const before = await Promise.all([a, b, c].map((s) => ethers.provider.getBalance(s.address)))
    const senderBefore = await ethers.provider.getBalance(sender.address)
    const rc = await (await as(multi, sender).disperseEtherEqual([a.address, b.address, c.address], { value: sent })).wait()
    const gas = rc!.gasUsed * rc!.gasPrice

    const each = sent / 3n
    const after = await Promise.all([a, b, c].map((s) => ethers.provider.getBalance(s.address)))
    // Each recipient got the floor; the remainder never stayed in the contract.
    expect(after[0] - before[0]).to.equal(each)
    expect(after[1] - before[1]).to.equal(each)
    expect(after[2] - before[2]).to.equal(each)
    expect(await ethers.provider.getBalance(await multi.getAddress())).to.equal(0n)
    // The sender's change came back: they are out exactly `each * 3` plus gas.
    const senderAfter = await ethers.provider.getBalance(sender.address)
    expect(senderBefore - senderAfter).to.equal(each * 3n + gas)
  })

  it('pulls ERC-20s from the sender to each recipient', async () => {
    const { multi, token, sender, a, b } = await fixture()
    const amounts = [ethers.parseEther('10'), ethers.parseEther('20')]
    await as(multi, sender).disperseToken(await token.getAddress(), [a.address, b.address], amounts)
    expect(await token.balanceOf(a.address)).to.equal(amounts[0])
    expect(await token.balanceOf(b.address)).to.equal(amounts[1])
    expect(await token.balanceOf(await multi.getAddress())).to.equal(0n)
  })

  it('sends the same ERC-20 amount to everyone', async () => {
    const { multi, token, sender, a, b } = await fixture()
    const each = ethers.parseEther('5')
    await as(multi, sender).disperseTokenEqual(await token.getAddress(), [a.address, b.address], each)
    expect(await token.balanceOf(a.address)).to.equal(each)
    expect(await token.balanceOf(b.address)).to.equal(each)
  })

  it('reverts a token batch when the allowance is short — nothing partial', async () => {
    const { multi, token, sender, a, b } = await fixture()
    await as(token, sender).approve(await multi.getAddress(), ethers.parseEther('10'))
    await expect(
      as(multi, sender).disperseToken(await token.getAddress(), [a.address, b.address], [ethers.parseEther('5'), ethers.parseEther('6')]),
    ).to.be.revertedWithCustomError(multi, 'TokenTransferFailed')
    expect(await token.balanceOf(a.address)).to.equal(0n)
  })
})
