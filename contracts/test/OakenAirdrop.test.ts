import { expect } from 'chai'
import { ethers } from 'hardhat'
import { as, jumpTo, latest } from './helpers'
import type { Contract } from 'ethers'

/**
 * The airdrop, driven by a tree built the same way the front end builds it.
 *
 * The point of writing the Merkle code out here instead of importing a library
 * is that the front end has no library either: the page that creates a campaign
 * and the page that claims from one both build this by hand, so the tree shape
 * is a thing this project owns and has to test — a leaf that hashes differently
 * here than in the browser is an airdrop nobody can claim from.
 */

const enc = ethers.AbiCoder.defaultAbiCoder()

/** `keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))` — the OZ shape. */
function leaf(index: number, account: string, amount: bigint): string {
  return ethers.keccak256(
    ethers.keccak256(enc.encode(['uint256', 'address', 'uint256'], [index, account, amount])),
  )
}

function hashPair(a: string, b: string): string {
  return ethers.keccak256(ethers.concat(a <= b ? [a, b] : [b, a]))
}

/** Sorted-pair tree; `proof(i)` walks the sibling path. */
function buildTree(rows: { index: number; account: string; amount: bigint }[]) {
  let level = rows.map((r) => leaf(r.index, r.account, r.amount))
  const layers: string[][] = [level]
  while (level.length > 1) {
    const next: string[] = []
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]
      const b = level[i + 1] ?? a           // odd node promoted, as in every simple tree
      next.push(a === b ? a : hashPair(a, b))
    }
    layers.push(next)
    level = next
  }
  const proof = (index: number): string[] => {
    const out: string[] = []
    let pos = index
    for (let l = 0; l < layers.length - 1; l++) {
      const layer = layers[l]
      const sibling = pos % 2 === 0 ? pos + 1 : pos - 1
      if (sibling < layer.length) out.push(layer[sibling])
      pos = Math.floor(pos / 2)
    }
    return out
  }
  return { root: level[0], proof }
}

describe('OakenAirdrop', () => {
  const DAY = 86400

  async function fixture() {
    const [creator, alice, bob, carol, mallory] = await ethers.getSigners()
    const airdrop: Contract = await ethers.deployContract('OakenAirdrop')
    const token: Contract = await ethers.deployContract('MockToken', ['Mock', 'MOCK'])
    await token.mint(creator.address, ethers.parseEther('100000'))

    const rows = [
      { index: 0, account: alice.address, amount: ethers.parseEther('100') },
      { index: 1, account: bob.address, amount: ethers.parseEther('50') },
      { index: 2, account: carol.address, amount: ethers.parseEther('25') },
    ]
    const { root, proof } = buildTree(rows)
    const total = rows.reduce((s, r) => s + r.amount, 0n)
    const deadline = BigInt((await latest()) + 30 * DAY)

    await as(token, creator).approve(await airdrop.getAddress(), total * 4n)
    return { airdrop, token, creator, alice, bob, carol, mallory, rows, root, proof, total, deadline }
  }

  async function createCampaign(f: Awaited<ReturnType<typeof fixture>>, amount = f.total, deadline = f.deadline) {
    const tx = await as(f.airdrop, f.creator).createCampaign(await f.token.getAddress(), f.root, amount, deadline)
    const rc = await tx.wait()
    const log = rc!.logs.map((l: any) => { try { return f.airdrop.interface.parseLog(l) } catch { return null } }).find(Boolean)
    return Number(log.args.id)
  }

  it('funds a campaign and claims every row', async () => {
    const f = await fixture()
    const id = await createCampaign(f)
    expect(await f.token.balanceOf(await f.airdrop.getAddress())).to.equal(f.total)

    for (const r of f.rows) {
      await as(f.airdrop, f.alice).claim(id, r.index, r.account, r.amount, f.proof(r.index))
      expect(await f.token.balanceOf(r.account)).to.equal(r.amount)
    }
    const c = await f.airdrop.campaign(id)
    expect(c.claimed).to.equal(f.total)
    expect(c.claimedRows).to.equal(3n)
  })

  it('lets anyone submit a claim, and pays the address the row names', async () => {
    const f = await fixture()
    const id = await createCampaign(f)
    const r = f.rows[0]
    // Mallory (no row) submits alice's claim; the tokens still go to alice.
    await as(f.airdrop, f.mallory).claim(id, r.index, r.account, r.amount, f.proof(r.index))
    expect(await f.token.balanceOf(r.account)).to.equal(r.amount)
    expect(await f.token.balanceOf(f.mallory.address)).to.equal(0n)
  })

  it('refuses a second claim of the same row, and any claim with a wrong amount', async () => {
    const f = await fixture()
    const id = await createCampaign(f)
    const r = f.rows[0]
    await as(f.airdrop, f.alice).claim(id, r.index, r.account, r.amount, f.proof(r.index))
    await expect(as(f.airdrop, f.alice).claim(id, r.index, r.account, r.amount, f.proof(r.index)))
      .to.be.revertedWithCustomError(f.airdrop, 'AlreadyClaimed')

    const r2 = f.rows[1]
    await expect(as(f.airdrop, f.bob).claim(id, r2.index, r2.account, r2.amount * 2n, f.proof(r2.index)))
      .to.be.revertedWithCustomError(f.airdrop, 'InvalidProof')
  })

  it('refuses a proof from a different campaign', async () => {
    const f = await fixture()
    const id = await createCampaign(f)
    const other = buildTree([{ index: 0, account: f.alice.address, amount: ethers.parseEther('1') }])
    await expect(as(f.airdrop, f.alice).claim(id, 0, f.alice.address, ethers.parseEther('1'), other.proof(0)))
      .to.be.revertedWithCustomError(f.airdrop, 'InvalidProof')
  })

  it('will not sweep before the deadline, and sweeps the unclaimed part after', async () => {
    const f = await fixture()
    const id = await createCampaign(f)
    const r = f.rows[0]
    await as(f.airdrop, f.alice).claim(id, r.index, r.account, r.amount, f.proof(r.index))

    await expect(as(f.airdrop, f.creator).sweep(id))
      .to.be.revertedWithCustomError(f.airdrop, 'DeadlineNotPassed')

    await jumpTo(Number(f.deadline) + 1)
    const before = await f.token.balanceOf(f.creator.address)
    await as(f.airdrop, f.creator).sweep(id)
    expect(await f.token.balanceOf(f.creator.address) - before).to.equal(f.total - r.amount)

    // Claims are over once it is swept.
    const r2 = f.rows[1]
    await expect(as(f.airdrop, f.bob).claim(id, r2.index, r2.account, r2.amount, f.proof(r2.index)))
      .to.be.revertedWithCustomError(f.airdrop, 'CampaignSwept')
  })

  it('only the creator can sweep', async () => {
    const f = await fixture()
    const id = await createCampaign(f)
    await jumpTo(Number(f.deadline) + 1)
    await expect(as(f.airdrop, f.mallory).sweep(id))
      .to.be.revertedWithCustomError(f.airdrop, 'NotCreator')
  })

  it('a sweep takes only its own campaign’s share', async () => {
    const f = await fixture()
    const first = await createCampaign(f)
    // A second campaign on the same token, funded with the same amount.
    await as(f.token, f.creator).approve(await f.airdrop.getAddress(), f.total)
    const second = await createCampaign(f)

    await jumpTo(Number(f.deadline) + 1)
    await as(f.airdrop, f.creator).sweep(first)
    // The second campaign's tokens are still there, untouched.
    expect(await f.token.balanceOf(await f.airdrop.getAddress())).to.equal(f.total)

    await as(f.airdrop, f.creator).sweep(second)
    expect(await f.token.balanceOf(await f.airdrop.getAddress())).to.equal(0n)
  })

  it('rejects a campaign with no root, no tokens, or a deadline in the past', async () => {
    const f = await fixture()
    const token = await f.token.getAddress()
    const now = BigInt(await latest())
    await expect(as(f.airdrop, f.creator).createCampaign(token, ethers.ZeroHash, f.total, f.deadline))
      .to.be.revertedWithCustomError(f.airdrop, 'EmptyRoot')
    await expect(as(f.airdrop, f.creator).createCampaign(token, f.root, 0n, f.deadline))
      .to.be.revertedWithCustomError(f.airdrop, 'ZeroAmount')
    await expect(as(f.airdrop, f.creator).createCampaign(token, f.root, f.total, now))
      .to.be.revertedWithCustomError(f.airdrop, 'DeadlineNotInFuture')
  })

  it('credits what actually arrived, not what was asked for', async () => {
    const f = await fixture()
    const feeToken: Contract = await ethers.deployContract('MockTokenNoReturn')
    await feeToken.mint(f.creator.address, ethers.parseEther('1000'))
    await as(feeToken, f.creator).approve(await f.airdrop.getAddress(), ethers.parseEther('1000'))
    // MockTokenNoReturn returns nothing from transferFrom — the other half of
    // the "tokens in the wild" problem, and `total` must still be right.
    const tx = await as(f.airdrop, f.creator).createCampaign(
      await feeToken.getAddress(), f.root, ethers.parseEther('1000'), f.deadline,
    )
    const rc = await tx.wait()
    const log = rc!.logs.map((l: any) => { try { return f.airdrop.interface.parseLog(l) } catch { return null } }).find(Boolean)
    expect(log.args.amount).to.equal(ethers.parseEther('1000'))
  })
})
