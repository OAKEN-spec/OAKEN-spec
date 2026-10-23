import { expect } from 'chai'
import { ethers, network } from 'hardhat'
import { as } from './helpers'
import type { Contract } from 'ethers'

/**
 * OakenTimelock.
 *
 * This is the only path by which OAKEN's admins can change anything after the
 * Safe migration, and the keeper will call `execute` unattended. The tests that
 * matter are therefore the refusals: too early, not queued, not the proposer,
 * replay, and a target that reverts (the inner reason must survive the bubble —
 * otherwise a failed governance action leaves no clue on chain).
 */
describe('OakenTimelock', () => {
  async function fixture() {
    const [proposer, canceller, stranger] = await ethers.getSigners()
    const tl: Contract = await ethers.deployContract('OakenTimelock', [
      86400,
      [proposer.address],
      [canceller.address],
    ])
    const target = await tl.getAddress()
    const data = tl.interface.encodeFunctionData('setDelay', [60])
    return { tl, proposer, canceller, stranger, target, data }
  }

  const now = async () => BigInt((await ethers.provider.getBlock('latest'))!.timestamp)
  const warp = async (seconds: number) => {
    await network.provider.send('evm_increaseTime', [seconds])
    await network.provider.send('evm_mine', [])
  }

  it('queues, refuses early execution, executes after eta, and cannot be replayed', async () => {
    const { tl, proposer, stranger, target, data } = await fixture()
    const eta = (await now()) + 86700n
    const id = await tl.idOf(target, data, eta)

    await expect(as(tl, proposer).queue(target, data, eta)).to.emit(tl, 'Queued')
    expect(await tl.etaOf(id)).to.equal(eta)

    await expect(as(tl, stranger).execute(target, data, eta))
      .to.be.revertedWithCustomError(tl, 'TooEarly')

    await warp(86701)
    await expect(as(tl, stranger).execute(target, data, eta)).to.emit(tl, 'Executed')
    expect(await tl.delay()).to.equal(60n)
    expect(await tl.etaOf(id)).to.equal(0n)

    await expect(as(tl, stranger).execute(target, data, eta))
      .to.be.revertedWithCustomError(tl, 'NotQueued')
  })

  it('only a proposer can queue, and eta must be at least now + delay', async () => {
    const { tl, stranger, target, data } = await fixture()
    const eta = (await now()) + 86700n
    await expect(as(tl, stranger).queue(target, data, eta))
      .to.be.revertedWithCustomError(tl, 'NotProposer')
    await expect(as(tl, stranger).queue(target, data, (await now()) + 100n))
      .to.be.revertedWithCustomError(tl, 'NotProposer') // role checked first
  })

  it('rejects an eta shorter than the delay', async () => {
    const { tl, proposer, target, data } = await fixture()
    const eta = (await now()) + 100n
    await expect(as(tl, proposer).queue(target, data, eta))
      .to.be.revertedWithCustomError(tl, 'DelayTooShort')
  })

  it('rejects queueing the same id twice', async () => {
    const { tl, proposer, target, data } = await fixture()
    const eta = (await now()) + 86700n
    await as(tl, proposer).queue(target, data, eta)
    await expect(as(tl, proposer).queue(target, data, eta))
      .to.be.revertedWithCustomError(tl, 'AlreadyQueued')
  })

  it('a canceller can remove a queued proposal; nobody else can', async () => {
    const { tl, proposer, canceller, stranger, target, data } = await fixture()
    const eta = (await now()) + 86700n
    const id = await tl.idOf(target, data, eta)
    await as(tl, proposer).queue(target, data, eta)

    await expect(as(tl, stranger).cancel(target, data, eta))
      .to.be.revertedWithCustomError(tl, 'NotCanceller')
    await expect(as(tl, canceller).cancel(target, data, eta)).to.emit(tl, 'Cancelled')
    expect(await tl.etaOf(id)).to.equal(0n)

    await warp(86701)
    await expect(as(tl, stranger).execute(target, data, eta))
      .to.be.revertedWithCustomError(tl, 'NotQueued')
  })

  it('bubbles the inner revert reason from the target', async () => {
    const { tl, proposer, stranger, target } = await fixture()
    // setProposer(0, true) is a call the timelock can make to itself but it reverts ZeroAddress.
    const data = tl.interface.encodeFunctionData('setProposer', [ethers.ZeroAddress, true])
    const eta = (await now()) + 86700n
    await as(tl, proposer).queue(target, data, eta)
    await warp(86701)
    await expect(as(tl, stranger).execute(target, data, eta))
      .to.be.revertedWithCustomError(tl, 'ZeroAddress')
  })

  it('self-administered changes must go through the timelock itself', async () => {
    const { tl, proposer, stranger } = await fixture()
    await expect(as(tl, proposer).setDelay(1))
      .to.be.revertedWithCustomError(tl, 'NotSelf')
    await expect(as(tl, stranger).setProposer(stranger.address, true))
      .to.be.revertedWithCustomError(tl, 'NotSelf')
    await expect(as(tl, stranger).setCanceller(stranger.address, true))
      .to.be.revertedWithCustomError(tl, 'NotSelf')
  })
})
