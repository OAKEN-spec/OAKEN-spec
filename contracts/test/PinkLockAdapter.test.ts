import { expect } from 'chai'
import { ethers } from 'hardhat'
import { latest, jumpTo, as } from './helpers'
import type { Contract } from 'ethers'

/**
 * The bridge, tested against the vault it writes into.
 *
 * The point of these tests is not that the adapter compiles — it is that a
 * PinkLock V2 shaped call lands in `LockVault` as the schedule PinkLock's own
 * numbers mean, and reads back in the tuple their record page expects. A
 * mapping that is off by a unit (days vs seconds, bps vs percent) still
 * produces a lock, still returns eleven fields, and is only visible by
 * comparing the two models field by field — which is what this file does.
 */
describe('PinkLockAdapter', () => {
  async function fixture() {
    const [user, other] = await ethers.getSigners()
    const vault: Contract = await ethers.deployContract('LockVault')
    const adapter: Contract = await ethers.deployContract('PinkLockAdapter', [await vault.getAddress()])

    const token: Contract = await ethers.deployContract('MockToken', ['Mock', 'MOCK'])
    await token.mint(user.address, ethers.parseEther('1000000'))
    // The form approves the address it thinks is PinkLock — i.e. the adapter.
    await as(token, user).approve(await adapter.getAddress(), ethers.MaxUint256)

    return { vault, adapter, token, user, other }
  }

  const amount = ethers.parseEther('1000')

  it('lock() 落进 vault，字段一对一', async () => {
    const { vault, adapter, token, user } = await load()
    const unlockDate = (await latest()) + 86_400

    await adapter.connect(user).lock(user.address, await token.getAddress(), false, amount, unlockDate, 'Team')

    const lock = await vault.getLock(1)
    expect(lock.token).to.equal(await token.getAddress())
    expect(lock.beneficiary).to.equal(user.address)
    expect(lock.amount).to.equal(amount)
    expect(lock.startTime).to.equal(unlockDate)
    expect(lock.cliffTime).to.equal(unlockDate)
    expect(lock.endTime).to.equal(unlockDate)
    expect(lock.initialUnlockBps).to.equal(0)

    // 代币真的离开了用户，且落在 vault 里（不是卡在适配器）
    expect(await token.balanceOf(user.address)).to.equal(ethers.parseEther('999000'))
    expect(await token.balanceOf(await vault.getAddress())).to.equal(amount)
    expect(await token.balanceOf(await adapter.getAddress())).to.equal(0)
  })

  it('getLockById 返回的是 PinkLock 那个元组的形状与取值', async () => {
    const { adapter, token, user } = await load()
    const unlockDate = (await latest()) + 86_400
    await adapter.connect(user).lock(user.address, await token.getAddress(), false, amount, unlockDate, 'Team')

    const v = await adapter.getLockById(1)
    expect(v.id).to.equal(1)
    expect(v.token).to.equal(await token.getAddress())
    expect(v.owner).to.equal(user.address)          // PinkLock 的 owner = 我们的 beneficiary
    expect(v.amount).to.equal(amount)
    expect(v.lockDate).to.equal(unlockDate)
    expect(v.tgeDate).to.equal(unlockDate)
    expect(v.unlockedAmount).to.equal(0)
    expect(v.description).to.equal('Team')          // 经 bytes32 往返后还在
  })

  it('vestingLock() 把「TGE + 每 cycle 秒 X%」翻成我们的阶梯，边界一致', async () => {
    const { vault, adapter, token, user } = await load()
    const tgeDate = (await latest()) + 86_400
    /**
     * `cycle` 是**秒**，不是天。
     *
     * 这一条以前写的是 `const cycle = 30 // 天`，断言 `endTime = tgeDate + 6 * cycle * 86_400`
     * —— 夹具跟着实现走，所以实现里那次多余的 `* 1 days` 一直测不出来。
     * 真界面把「Cycle (days) = 30」换算成 2592000 才送进合约（PinkLock V2 那个参数
     * 本来就是秒），于是链上算出来的是 46,656,000 天，解锁日期落在公元 129767 年。
     * 2026-10-10 真跑一次 vesting 创建才发现。现在夹具照**真界面**的样子写。
     */
    const cycle = 30 * 86_400   // 「30 天」在协议里就是 2592000 秒
    const tgeBps = 1000     // 10%
    const cycleBps = 1500   // 每周期 15%；尾数 9000/1500 = 6 步

    await adapter.connect(user).vestingLock(user.address, await token.getAddress(), false, amount, tgeDate, tgeBps, cycle, cycleBps, 'Team')

    const lock = await vault.getLock(1)
    expect(lock.startTime).to.equal(tgeDate)
    expect(lock.cliffTime).to.equal(tgeDate)
    expect(lock.initialUnlockBps).to.equal(tgeBps)
    expect(lock.steps).to.equal(6)
    // 6 步 × cycle 秒，最后一步正好落在 endTime 上（**不再乘 86400**）
    expect(lock.endTime).to.equal(tgeDate + 6 * cycle)
    // 而且这个日期必须落在一个人类尺度里 —— 上面那次双倍换算就是靠这条守住的
    expect(Number(lock.endTime) - tgeDate).to.equal(180 * 86_400)

    // TGE 那一刻可领 10%
    await jumpTo(tgeDate)
    expect(await vault.claimable(1)).to.equal(amount / 10n)
    // 再过 3 个周期：10% + 3×15% = 55%
    await jumpTo(tgeDate + 3 * cycle)
    expect(await vault.claimable(1)).to.equal((amount * 5500n) / 10_000n)
    // 到 endTime 全额（ethers v6 返回 bigint，jumpTo 走 provider 序列化，要转回 number）
    await jumpTo(Number(lock.endTime))
    expect(await vault.claimable(1)).to.equal(amount)
  })

  it('unlock() 是「谁都能按、钱只给受益人」', async () => {
    const { vault, adapter, token, user, other } = await load()
    const unlockDate = (await latest()) + 100
    await adapter.connect(user).lock(user.address, await token.getAddress(), false, amount, unlockDate, 'Team')

    await jumpTo(unlockDate + 1)
    const before = await token.balanceOf(user.address)
    // 陌生人代付 gas
    await adapter.connect(other).unlock(1)

    expect(await token.balanceOf(user.address)).to.equal(before + amount)
    expect(await token.balanceOf(other.address)).to.equal(0)
    expect((await vault.getLock(1)).claimed).to.equal(amount)
  })

  it('按代币 / 按用户 的索引跟着创建长出来', async () => {
    const { adapter, token, user, other } = await load()
    const unlockDate = (await latest()) + 86_400
    await adapter.connect(user).lock(user.address, await token.getAddress(), false, amount, unlockDate, 'A')
    await adapter.connect(user).lock(other.address, await token.getAddress(), false, amount, unlockDate, 'B')

    expect(await adapter.totalLockCountForToken(await token.getAddress())).to.equal(2)
    expect(await adapter.getTotalLockCount()).to.equal(2)
    expect(await adapter.totalLockCountForUser(user.address)).to.equal(1)
    expect(await adapter.totalLockCountForUser(other.address)).to.equal(1)

    const forToken = await adapter.getLocksForToken(await token.getAddress(), 0, 10)
    expect(forToken.length).to.equal(2)
    expect(forToken[1].description).to.equal('B')
  })

  it('分页范围是**闭区间** —— 页面只有一条锁时传的就是 [0,0]', async () => {
    const { adapter, token, user } = await load()
    const unlockDate = (await latest()) + 86_400
    await adapter.connect(user).lock(user.address, await token.getAddress(), false, amount, unlockDate, 'A')

    /**
     * 判据来自调用方，不是我们拍的：`getLockedAmountInPinklockV2` 里
     * `Array(count).fill(null).map((t,e)=>e)` 再 `chunk(...,100)`，于是**只有一条锁
     * 时它传的是 `[0, 0]`**。半开区间（end 不含）会把这一条整段吃掉，代币页的
     * 「Lock Records」就是一张只有表头的空表 —— 而 Current Locked Amount 照常显示
     * （它走另一个调用），看起来像"这把锁还没有记录"。2026-10-10 全量自检抓到。
     */
    const one = await adapter.getLocksForToken(await token.getAddress(), 0, 0)
    expect(one.length).to.equal(1, '闭区间：start=end 应当包含那一条')
    expect(one[0].description).to.equal('A')

    // 上界超出就夹到末尾，而不是回空
    const clamped = await adapter.getLocksForToken(await token.getAddress(), 0, 99)
    expect(clamped.length).to.equal(1)
    // 起点越界仍然是空，不是环绕
    const past = await adapter.getLocksForToken(await token.getAddress(), 5, 9)
    expect(past.length).to.equal(0)

    // 全局范围同理
    const range = await adapter.getCumulativeNormalTokenLockInfo(0, 0)
    expect(range.length).to.equal(1)
  })

  it('四个"改锁"动作真的转发到 vault，且只有受益人点得动', async () => {
    const { vault, adapter, token, user, other } = await load()
    const unlockDate = (await latest()) + 86_400
    await adapter.connect(user).lock(user.address, await token.getAddress(), false, amount, unlockDate, 'A')

    // 创建时就把 agent 声明成适配器 —— 这是这几个动作能被转发的全部依据
    const created = await vault.getLock(1)
    expect(created.agent).to.equal(await adapter.getAddress())

    // 别人点不动：vault 给了适配器这份权力，适配器不往外发
    await expect(adapter.connect(other).transferLockOwnership(1, other.address))
      .to.be.revertedWithCustomError(adapter, 'Unsupported').withArgs('not the lock owner')
    await expect(adapter.connect(other).renounceLockOwnership(1))
      .to.be.revertedWithCustomError(adapter, 'Unsupported').withArgs('not the lock owner')

    // 受益人点得动，而且链上真的变了
    await adapter.connect(user).transferLockOwnership(1, other.address)
    expect((await vault.getLock(1)).beneficiary).to.equal(other.address)

    // 改标题
    await adapter.connect(other).editLockDescription(1, 'Renamed')
    expect((await vault.getLock(1)).label).to.equal(ethers.encodeBytes32String('Renamed'))

    // 改金额：往下改不需要授权，多出来的退回受益人
    const before = await token.balanceOf(other.address)
    await adapter.connect(other).editLock(1, amount / 2n, unlockDate)
    const lock = await vault.getLock(1)
    expect(lock.amount).to.equal(amount / 2n)
    expect(await token.balanceOf(other.address)).to.equal(before + amount / 2n)

    // 放弃所有权：vault 里 renounced 真的落了
    await adapter.connect(other).renounceLockOwnership(1)
    expect((await vault.getLock(1)).renounced).to.equal(true)
  })

  it('改锁往**上**改时，代币从这里走一遭：没授权就整笔失败', async () => {
    const { vault, adapter, token, user } = await load()
    const unlockDate = (await latest()) + 86_400
    await adapter.connect(user).lock(user.address, await token.getAddress(), false, amount, unlockDate, 'A')

    // 用户把给适配器的授权撤了，往上加额就该失败 —— 而不是记一个 vault 拿不到的数量
    await as(token, user).approve(await adapter.getAddress(), 0)
    await expect(adapter.connect(user).editLock(1, amount * 2n, unlockDate))
      .to.be.revertedWithCustomError(adapter, 'Unsupported').withArgs('token transferFrom')
    expect((await vault.getLock(1)).amount).to.equal(amount)

    // 重新授权之后能加上去
    await as(token, user).approve(await adapter.getAddress(), ethers.MaxUint256)
    await adapter.connect(user).editLock(1, amount * 2n, unlockDate)
    expect((await vault.getLock(1)).amount).to.equal(amount * 2n)
  })

  it('没有代币授权就整笔失败，不会留下一半状态', async () => {
    const { adapter, vault, user } = await load()
    const loose: Contract = await ethers.deployContract('MockToken', ['Loose', 'LOOSE'])
    await loose.mint(user.address, amount)

    await expect(
      adapter.connect(user).lock(user.address, await loose.getAddress(), false, amount, (await latest()) + 100, 'X')
    ).to.be.reverted

    expect(await vault.nextLockId()).to.equal(1)
    expect(await adapter.getTotalLockCount()).to.equal(0)
  })

  /** Each test gets a fresh deployment; kept as a name so the tests read short. */
  async function load() {
    return fixture()
  }
})
