import { expect } from 'chai'
import { ethers } from 'hardhat'
import { as, jumpTo, latest, loadFixture } from './helpers'
import type { Contract } from 'ethers'

/**
 * v4 — the v3 accounting behind an ERC1967 proxy.
 *
 * What these tests pin:
 *   · the proxy's admin/implementation slots point where we think they do;
 *   · initialize is one-shot, on the proxy and on the implementation;
 *   · non-admins cannot touch the admin functions;
 *   · locks created through the adapter proxy work end to end;
 *   · an upgrade is 2-of-3 + 48h, and it preserves the vault's state;
 *   · the adapter upgrade keeps its vault address and its indexes;
 *   · the launcher works through the adapter proxy.
 *
 * The adversarial fuzz/invariant suites remain the v1/v3 ones; this is the
 * upgrade-path regression.
 */
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'
const DELAY = 48 * 3600

async function slotAddress(proxy: string, slot: string): Promise<string> {
  const raw = await ethers.provider.getStorage(proxy, slot)
  return ethers.getAddress('0x' + raw.slice(26))
}

async function fixture() {
  const [o1, o2, o3, creator, beneficiary, other] = await ethers.getSigners()

  const multisig: Contract = await ethers.deployContract('OakenMultisig', [
    [o1.address, o2.address, o3.address],
    2,
  ])
  const admin: Contract = await ethers.deployContract('DelayedProxyAdmin', [
    await multisig.getAddress(),
    DELAY,
  ])

  const vaultImpl: Contract = await ethers.deployContract('LockVaultV4')
  const vaultProxy: Contract = await ethers.deployContract('ERC1967Proxy', [
    await admin.getAddress(),
    await vaultImpl.getAddress(),
    vaultImpl.interface.encodeFunctionData('initialize'),
  ])
  const vault: Contract = await ethers.getContractAt('LockVaultV4', await vaultProxy.getAddress())

  const adapterImpl: Contract = await ethers.deployContract('PinkLockAdapterV4')
  const adapterProxy: Contract = await ethers.deployContract('ERC1967Proxy', [
    await admin.getAddress(),
    await adapterImpl.getAddress(),
    adapterImpl.interface.encodeFunctionData('initialize', [await vaultProxy.getAddress()]),
  ])
  const adapter: Contract = await ethers.getContractAt('PinkLockAdapterV4', await adapterProxy.getAddress())

  const token: Contract = await ethers.deployContract('MockToken', ['Mock', 'MOCK'])
  const amount = ethers.parseEther('100')
  await token.mint(creator.address, amount * 10n)
  await as(token, creator).approve(await adapter.getAddress(), ethers.MaxUint256)

  return {
    o1, o2, o3, creator, beneficiary, other,
    multisig, admin, vaultImpl, vaultProxy, vault, adapterImpl, adapterProxy, adapter, token, amount,
  }
}

/** Submit + confirm + execute a multisig call. Returns the transaction id. */
async function viaMultisig(multisig: Contract, owner1: any, owner2: any, target: string, data: string) {
  const tx = await as(multisig, owner1).submit(target, 0, data)
  const rc = await tx.wait()
  const ev = rc!.logs
    .map((l: any) => { try { return multisig.interface.parseLog(l) } catch { return null } })
    .find((x: any) => x && x.name === 'Submission')
  const id = ev!.args.id
  await (await as(multisig, owner2).confirm(id)).wait()
  await (await as(multisig, owner1).execute(id)).wait()
  return id as bigint
}

async function lockOnce(f: Awaited<ReturnType<typeof fixture>>) {
  const unlock = (await latest()) + 3600
  await (await as(f.adapter, f.creator).lock(
    f.beneficiary.address, await f.token.getAddress(), false, f.amount, unlock, 'v4 lock',
  )).wait()
  return unlock
}

describe('v4 — upgradeable vault and adapter', () => {
  it('the proxy points at the implementation and at the delayed admin', async () => {
    const f = await loadFixture(fixture)
    const proxyAddr = await f.vaultProxy.getAddress()
    expect(await slotAddress(proxyAddr, IMPL_SLOT)).to.equal(await f.vaultImpl.getAddress())
    expect(await slotAddress(proxyAddr, ADMIN_SLOT)).to.equal(await f.admin.getAddress())
    expect(await f.vault.version()).to.equal('v4')
    expect(await f.vault.nextLockId()).to.equal(1n)
    expect(await f.adapter.vault()).to.equal(proxyAddr)
  })

  it('initialize is one-shot on the proxy and disabled on the implementation', async () => {
    const f = await loadFixture(fixture)
    await expect(f.vault.initialize()).to.be.revertedWithCustomError(f.vault, 'AlreadyInitialized')
    await expect(f.vaultImpl.initialize()).to.be.revertedWithCustomError(f.vaultImpl, 'AlreadyInitialized')
    await expect(f.adapter.initialize(await f.vault.getAddress())).to.be.revertedWithCustomError(f.adapter, 'AlreadyInitialized')
  })

  it('only the admin can use the admin functions', async () => {
    const f = await loadFixture(fixture)
    await expect(
      as(f.vaultProxy, f.other).upgradeTo(await f.vaultImpl.getAddress()),
    ).to.be.revertedWithCustomError(f.vaultProxy, 'NotAdmin')
    await expect(as(f.vaultProxy, f.other).admin()).to.be.revertedWithCustomError(f.vaultProxy, 'NotAdmin')
  })

  it('locks and claims work through the adapter proxy', async () => {
    const f = await loadFixture(fixture)
    const unlock = await lockOnce(f)
    const l = await f.vault.getLock(1)
    expect(l.amount).to.equal(f.amount)
    expect(l.beneficiary).to.equal(f.beneficiary.address)
    expect(await f.adapter.getTotalLockCount()).to.equal(1n)
    expect(await f.token.balanceOf(await f.vault.getAddress())).to.equal(f.amount)

    await expect(as(f.adapter, f.other).unlock(1)).to.be.reverted
    await jumpTo(unlock + 1)
    await (await as(f.adapter, f.other).unlock(1)).wait()
    expect(await f.token.balanceOf(f.beneficiary.address)).to.equal(f.amount)
  })

  it('upgrade needs 2-of-3 and 48h, and preserves locks', async () => {
    const f = await loadFixture(fixture)
    await lockOnce(f)
    const mock: Contract = await ethers.deployContract('LockVaultV4UpgradeMock')
    const proxy = await f.vaultProxy.getAddress()
    const adminAddr = await f.admin.getAddress()

    const schedule = f.admin.interface.encodeFunctionData('scheduleUpgrade', [proxy, await mock.getAddress()])
    await viaMultisig(f.multisig, f.o1, f.o2, adminAddr, schedule)
    const [impl, eta] = await f.admin.pendingUpgrade(proxy)
    expect(impl).to.equal(await mock.getAddress())
    expect(Number(eta)).to.be.greaterThan(await latest())

    // too early: the inner call reverts TooEarly, so the multisig call fails
    const executeData = f.admin.interface.encodeFunctionData('executeUpgrade', [proxy])
    const early = await as(f.multisig, f.o1).submit(adminAddr, 0, executeData)
    const earlyRc = await early.wait()
    const earlyId = earlyRc!.logs
      .map((l: any) => { try { return f.multisig.interface.parseLog(l) } catch { return null } })
      .find((x: any) => x && x.name === 'Submission')!.args.id
    await (await as(f.multisig, f.o2).confirm(earlyId)).wait()
    await expect(as(f.multisig, f.o1).execute(earlyId)).to.be.revertedWithCustomError(f.multisig, 'CallFailed')

    await jumpTo(Number(eta) + 1)
    await viaMultisig(f.multisig, f.o1, f.o2, adminAddr, executeData)

    expect(await slotAddress(proxy, IMPL_SLOT)).to.equal(await mock.getAddress())
    expect(await f.vault.version()).to.equal('v4.1-mock')
    expect(await f.vault.nextLockId()).to.equal(2n)
    const l = await f.vault.getLock(1)
    expect(l.amount).to.equal(f.amount)
    expect(l.beneficiary).to.equal(f.beneficiary.address)

    const mockVault: Contract = await ethers.getContractAt('LockVaultV4UpgradeMock', proxy)
    expect(await mockVault.probe()).to.equal(0n)
    await (await as(mockVault, f.creator).setProbe(7)).wait()
    expect(await mockVault.probe()).to.equal(7n)
  })

  it('a scheduled upgrade can be cancelled', async () => {
    const f = await loadFixture(fixture)
    const proxy = await f.vaultProxy.getAddress()
    const adminAddr = await f.admin.getAddress()
    const mock: Contract = await ethers.deployContract('LockVaultV4UpgradeMock')

    const schedule = f.admin.interface.encodeFunctionData('scheduleUpgrade', [proxy, await mock.getAddress()])
    await viaMultisig(f.multisig, f.o1, f.o2, adminAddr, schedule)
    const cancel = f.admin.interface.encodeFunctionData('cancelUpgrade', [proxy])
    await viaMultisig(f.multisig, f.o1, f.o2, adminAddr, cancel)
    const [impl] = await f.admin.pendingUpgrade(proxy)
    expect(impl).to.equal(ethers.ZeroAddress)

    const executeData = f.admin.interface.encodeFunctionData('executeUpgrade', [proxy])
    const tx = await as(f.multisig, f.o1).submit(adminAddr, 0, executeData)
    const rc = await tx.wait()
    const id = rc!.logs
      .map((l: any) => { try { return f.multisig.interface.parseLog(l) } catch { return null } })
      .find((x: any) => x && x.name === 'Submission')!.args.id
    await (await as(f.multisig, f.o2).confirm(id)).wait()
    await expect(as(f.multisig, f.o1).execute(id)).to.be.revertedWithCustomError(f.multisig, 'CallFailed')
  })

  it('non-owners cannot confirm or execute', async () => {
    const f = await loadFixture(fixture)
    const data = f.admin.interface.encodeFunctionData('setDelay', [1])
    const tx = await as(f.multisig, f.o1).submit(await f.admin.getAddress(), 0, data)
    const rc = await tx.wait()
    const id = rc!.logs
      .map((l: any) => { try { return f.multisig.interface.parseLog(l) } catch { return null } })
      .find((x: any) => x && x.name === 'Submission')!.args.id
    await expect(as(f.multisig, f.other).confirm(id)).to.be.revertedWithCustomError(f.multisig, 'NotOwner')
    await expect(as(f.multisig, f.other).execute(id)).to.be.revertedWithCustomError(f.multisig, 'NotOwner')
  })

  it('the adapter can be upgraded without losing its vault or its indexes', async () => {
    const f = await loadFixture(fixture)
    await lockOnce(f)
    const mock: Contract = await ethers.deployContract('PinkLockAdapterV4UpgradeMock')
    const proxy = await f.adapterProxy.getAddress()
    const adminAddr = await f.admin.getAddress()

    const schedule = f.admin.interface.encodeFunctionData('scheduleUpgrade', [proxy, await mock.getAddress()])
    await viaMultisig(f.multisig, f.o1, f.o2, adminAddr, schedule)
    const [, eta] = await f.admin.pendingUpgrade(proxy)
    await jumpTo(Number(eta) + 1)
    await viaMultisig(f.multisig, f.o1, f.o2, adminAddr, f.admin.interface.encodeFunctionData('executeUpgrade', [proxy]))

    const upgraded: Contract = await ethers.getContractAt('PinkLockAdapterV4UpgradeMock', proxy)
    expect(await upgraded.version()).to.equal('v4.1-mock')
    expect(await upgraded.vault()).to.equal(await f.vault.getAddress())
    expect(await upgraded.getTotalLockCount()).to.equal(1n)
    const rows = await upgraded.getLocksForToken(await f.token.getAddress(), 0, 1000)
    expect(rows.length).to.equal(1)
    expect(rows[0].id).to.equal(1n)
  })

  it('the launcher works through the adapter proxy', async () => {
    const f = await loadFixture(fixture)
    const factory: Contract = await ethers.deployContract('TokenFactory')
    const launcher: Contract = await ethers.deployContract('OakenLauncher', [
      await factory.getAddress(),
      await f.adapter.getAddress(),
    ])
    const now = (await latest()) + 1
    const tx = await as(launcher, f.creator).launch({
      name: 'Proxy Launch',
      symbol: 'PLCH',
      decimals: 18,
      supply: ethers.parseEther('1000000'),
      lockBps: 2500,
      unlockDate: now + 86400 * 30,
      description: 'through the proxy',
      beneficiary: f.creator.address,
    })
    const rc = await tx.wait()
    const ev = rc!.logs
      .map((l: any) => { try { return launcher.interface.parseLog(l) } catch { return null } })
      .find((x: any) => x && x.name === 'Launched')!
    const token: Contract = await ethers.getContractAt('MockToken', ev.args.token)
    const l = await f.vault.getLock(ev.args.lockId)
    expect(await token.balanceOf(f.creator.address)).to.equal(ethers.parseEther('750000'))
    expect(await token.balanceOf(await f.vault.getAddress())).to.equal(ethers.parseEther('250000'))
    expect(l.amount).to.equal(ethers.parseEther('250000'))
    expect(l.beneficiary).to.equal(f.creator.address)
    expect(await f.adapter.getTotalLockCount()).to.equal(1n)
  })
})
