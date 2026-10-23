import { expect } from 'chai'
import { ethers } from 'hardhat'
import { as, loadFixture } from './helpers'
import type { Contract } from 'ethers'

/**
 * The launcher: one transaction that creates a token and locks a slice of it.
 *
 * The assertions that matter are the ones about **the two indexes the site
 * reads**. A lock that exists in the vault but is missing from the adapter's
 * per-owner / per-token lists is a lock the record page shows and `/me` and the
 * token page do not — the failure this design routes through the adapter to
 * avoid. So the tests check both the vault's state and the adapter's lists.
 */
describe('OakenLauncher', () => {
  async function fixture() {
    const [creator, alice, bob] = await ethers.getSigners()
    const factory: Contract = await ethers.deployContract('TokenFactory')
    const vault: Contract = await ethers.deployContract('LockVault')
    const adapter: Contract = await ethers.deployContract('PinkLockAdapter', [await vault.getAddress()])
    const launcher: Contract = await ethers.deployContract('OakenLauncher', [
      await factory.getAddress(),
      await adapter.getAddress(),
    ])
    return { factory, vault, adapter, launcher, creator, alice, bob }
  }

  /** 默认参数；测试里覆盖其中几项。 */
  async function params(over: Partial<Record<string, unknown>> = {}) {
    const now = (await ethers.provider.getBlock('latest'))!.timestamp
    return {
      name: 'Launched Token',
      symbol: 'LNCH',
      decimals: 18,
      supply: ethers.parseEther('1000000'),
      lockBps: 0,
      unlockDate: now + 86400 * 180,
      description: 'Fair launch + lock',
      beneficiary: ethers.ZeroAddress,
      ...over,
    }
  }

  /** 发一次，返回 token 地址与事件参数。 */
  async function launch(launcher: Contract, signer: any, over: Partial<Record<string, unknown>> = {}) {
    const tx = await as(launcher, signer).launch(await params(over))
    const rc = await tx.wait()
    const log = rc!.logs
      .map((l: any) => { try { return launcher.interface.parseLog(l) } catch { return null } })
      .find((x: any) => x && x.name === 'Launched')
    return { token: await ethers.getContractAt('OakenToken', log!.args.token), args: log!.args }
  }

  it('creates the token and hands the whole supply to the creator when nothing is locked', async () => {
    const { factory, launcher, creator } = await loadFixture(fixture)
    const supply = ethers.parseEther('1000000')
    const { token, args } = await launch(launcher, creator, { supply })

    expect(await token.name()).to.equal('Launched Token')
    expect(await token.totalSupply()).to.equal(supply)
    expect(await token.balanceOf(creator.address)).to.equal(supply)
    expect(await token.balanceOf(await launcher.getAddress())).to.equal(0n)   // 合约不留余额
    expect(await factory.tokenCount()).to.equal(1n)                          // 工厂照常登记
    expect(args.locked).to.equal(0n)
    expect(args.lockId).to.equal(0n)
  })

  it('locks the requested slice into the vault and sends the rest to the creator', async () => {
    const { vault, adapter, launcher, creator } = await loadFixture(fixture)
    const supply = ethers.parseEther('1000000')
    const unlockDate = (await ethers.provider.getBlock('latest'))!.timestamp + 86400 * 90

    const { token, args } = await launch(launcher, creator, { supply, lockBps: 2500, unlockDate })
    const tokenAddr = await token.getAddress()

    // 金库里 25%，创建者手上 75%
    expect(await token.balanceOf(await vault.getAddress())).to.equal(supply / 4n)
    expect(await token.balanceOf(creator.address)).to.equal(supply - supply / 4n)
    expect(args.locked).to.equal(supply / 4n)

    // 这把锁：受益人是创建者、agent 是**适配器**（记录页上的转移/放弃都靠它）
    const lock = await vault.getLock(args.lockId)
    expect(lock.token).to.equal(tokenAddr)
    expect(lock.beneficiary).to.equal(creator.address)
    expect(lock.agent).to.equal(await adapter.getAddress())
    expect(lock.amount).to.equal(supply / 4n)
    expect(lock.endTime).to.equal(unlockDate)

    // ⚠ 这两张表就是 `/me` 与代币页的数据源 —— 少了任何一张，那把锁"查得到、列不出"
    const forUser = await adapter.normalLocksForUser(creator.address)
    expect(forUser.length).to.equal(1)
    expect(forUser[0].id).to.equal(args.lockId)
    expect(await adapter.totalLockCountForToken(tokenAddr)).to.equal(1n)
    const forToken = await adapter.getLocksForToken(tokenAddr, 0, 0)
    expect(forToken[0].id).to.equal(args.lockId)
    expect(forToken[0].owner).to.equal(creator.address)
  })

  it('split() is the same arithmetic the launch performs', async () => {
    const { vault, launcher, creator } = await loadFixture(fixture)
    // 前端预览调 split()，链上按同一套整除切分 —— 两边算出不同的数就是
    // "页面写着锁 25%、链上锁了 24.99%" 那类没人能一眼看出的差
    const supply = ethers.parseEther('1000000')
    const [locked] = await launcher.split(supply, 2500)
    const { token, args } = await launch(launcher, creator, { supply, lockBps: 2500 })

    expect(locked).to.equal(supply / 4n)
    expect(args.locked).to.equal(locked)
    expect(await token.balanceOf(await vault.getAddress())).to.equal(locked)
    expect(await token.balanceOf(creator.address)).to.equal(supply - locked)
  })

  it('split() keeps the remainder on the creator side when it does not divide evenly', async () => {
    const { vault, launcher, creator } = await loadFixture(fixture)
    const supply = 1000003n            // 素数，保证除不尽
    const [locked, rest] = await launcher.split(supply, 3333)
    expect(locked + rest).to.equal(supply)

    // 不锁的那部分走 split 里算出来的 `rest` 之外的真实路径：
    // 合约分配的是**实收余额**，所以两边必须以它为准
    const { token } = await launch(launcher, creator, { supply, lockBps: 3333 })
    expect(await token.balanceOf(await vault.getAddress())).to.equal(locked)
    expect(await token.balanceOf(creator.address)).to.equal(supply - locked)
  })

  it('refuses a share above 100% and a share that rounds to nothing', async () => {
    const { launcher, creator } = await loadFixture(fixture)

    await expect(launch(launcher, creator, { lockBps: 10_001 }))
      .to.be.revertedWithCustomError(launcher, 'LockShareTooHigh')

    // 供应量 3、比例 1bp → 3*1/10000 = 0：**看起来锁了、其实一枚都没锁**，必须 revert
    await expect(launch(launcher, creator, { supply: 3n, lockBps: 1 }))
      .to.be.revertedWithCustomError(launcher, 'NothingToLock')

    expect(await launcher.split(3n, 1)).to.deep.equal([0n, 3n])
  })

  it('locks for someone else without giving them the unlocked part', async () => {
    const { vault, launcher, creator, alice } = await loadFixture(fixture)
    const supply = ethers.parseEther('1000')
    const { token, args } = await launch(launcher, creator, {
      supply,
      lockBps: 5000,
      beneficiary: alice.address,
    })

    // 锁归 alice，没锁的那一半仍然归**发起人**
    expect((await vault.getLock(args.lockId)).beneficiary).to.equal(alice.address)
    expect(await token.balanceOf(alice.address)).to.equal(0n)
    expect(await token.balanceOf(creator.address)).to.equal(supply / 2n)
    expect((await args).beneficiary).to.equal(alice.address)
  })

  it('the beneficiary can still move the lock through the adapter', async () => {
    const { vault, adapter, launcher, creator, bob } = await loadFixture(fixture)
    const { args } = await launch(launcher, creator, { lockBps: 1000 })

    // 记录页上的「Transfer」走的就是这条路：适配器转发，金库只认受益人/agent
    await as(adapter, creator).transferLockOwnership(args.lockId, bob.address)
    expect((await vault.getLock(args.lockId)).beneficiary).to.equal(bob.address)

    /**
     * ⚠ 但适配器那张 `_idsByOwner` 表**只在创建时追加**，转赠不会跟着改：
     *   转出去的锁仍然列在原来那个地址名下，**别人转给你的锁则完全不出现**。
     *
     * 这条**不是这一轮引入的**（适配器一直如此），记录页读金库所以永远是对的；
     * 但 `/me` 的「Locks held for you」按这张表列 —— 口径要么改成"当前受益人"，
     * 要么把文案改成"你创建过的锁"。先在这里钉住现状，改口径要单独一轮。
     */
    expect((await adapter.normalLocksForUser(bob.address)).length).to.equal(0)
    expect((await adapter.normalLocksForUser(creator.address)).length).to.equal(1)
  })
})
