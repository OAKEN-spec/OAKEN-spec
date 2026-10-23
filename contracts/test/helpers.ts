/**
 * Test helpers, dependency-free.
 *
 * The repo's convention is a test suite that needs nothing beyond Hardhat,
 * ethers and chai; `@nomicfoundation/hardhat-network-helpers` is not installed
 * and its current major targets Hardhat 3 anyway. The three things it would
 * have provided are small enough to write out, and writing them out makes the
 * snapshot semantics visible rather than assumed.
 */

import { ethers, network } from 'hardhat'
import type { Contract, Signer } from 'ethers'

/**
 * Re-widen a contract after `connect`.
 *
 * ethers v6 types `Contract.connect` as returning the bare `BaseContract`,
 * which declares no methods, so under `strict` every
 * `contract.connect(who).someMethod()` is a type error and every call site
 * needs a cast. One helper is better than a cast in forty places. The other
 * contract project in this repo does the same thing for the same reason.
 *
 * There is no typechain step here on purpose: the ABI's real specification is
 * the Solidity, and generating a second description of it to satisfy the
 * compiler creates something that can disagree with the first.
 */
export function as(contract: Contract, signer: Signer): Contract {
  return contract.connect(signer) as Contract
}

/** Timestamp of the most recently mined block. */
export async function latest(): Promise<number> {
  return (await ethers.provider.getBlock('latest'))!.timestamp
}

/**
 * Mine a block whose timestamp is exactly `target`.
 *
 * `evm_setNextBlockTimestamp` rather than `evm_increaseTime`: the vesting
 * assertions are equalities against a schedule, so a test has to own the
 * timestamp rather than add an offset to whatever the last block happened to
 * be. Increase-time would also let the elapsed seconds drift with each block
 * mined in between, which is exactly the quantity under test.
 */
export async function jumpTo(target: number) {
  await network.provider.send('evm_setNextBlockTimestamp', [target])
  await network.provider.send('evm_mine', [])
}

/**
 * Run `action` in a block whose timestamp is exactly `target`.
 *
 * `jumpTo` mines a block at `target`, but the transaction that follows lands in
 * the *next* block, one second later. Vesting assertions are equalities, so a
 * test that means "claim at T+250" has to mine at T+249 and let the call land
 * on T. Getting this wrong shifts every expected amount by one second of
 * accrual — small enough to look like a rounding notion, and wrong in exactly
 * the dimension the tests exist to pin down.
 */
export async function at<T>(target: number, action: () => Promise<T>): Promise<T> {
  await jumpTo(target - 1)
  return action()
}

/**
 * Deploy the fixture once, then restore the chain to that moment before every
 * test that asks for the same fixture function.
 *
 * The revert is the point. Returning cached contract handles without reverting
 * would leave each test mutating the same storage, so a test would pass or fail
 * depending on the order it ran in — and the failures would land on the tests
 * about vesting arithmetic, which are exactly the ones that must not be flaky.
 *
 * The cache is keyed by the fixture function, which is why the identity of the
 * function matters: each `describe` defines its own and gets its own snapshot.
 */
const fixtures = new WeakMap<() => Promise<unknown>, { value: unknown; snapshot: string }>()

export async function loadFixture<T>(fn: () => Promise<T>): Promise<T> {
  const cached = fixtures.get(fn)
  if (cached === undefined) {
    const value = await fn()
    const snapshot = await network.provider.send('evm_snapshot', [])
    fixtures.set(fn, { value, snapshot })
    return value
  }

  await network.provider.send('evm_revert', [cached.snapshot])
  // Take a fresh snapshot after every revert: a reverted id is not guaranteed
  // to still be usable for the next test.
  const snapshot = await network.provider.send('evm_snapshot', [])
  fixtures.set(fn, { value: cached.value, snapshot })
  return cached.value as T
}
