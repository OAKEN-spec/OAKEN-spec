import { expect } from 'chai'
import { ethers } from 'hardhat'
import { as } from './helpers'
import type { Contract } from 'ethers'

/**
 * Flap-model graduation adapters.
 *
 * V2 (tax tokens): addLiquidityETH, LP held by the graduator, pair registered
 * in the token. V3 (standard tokens): a full-range Pancake V3 position, NFT
 * held by the graduator. Both are judged by what the DEX-facing mock was
 * actually asked to do.
 */
describe('Flap graduators', () => {
  const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
  const TOKEN_AMOUNT = ethers.parseEther('200000000')
  const QUOTE = ethers.parseEther('16')
  const SUPPLY = ethers.parseEther('1000000000')

  it('V2 adds liquidity, registers the pair and keeps the LP', async () => {
    const [deployer, factory, creator, pool, protocol] = await ethers.getSigners()
    const mockFactory: Contract = await ethers.deployContract('MockPancakeFactory', [pool.address])
    const router: Contract = await ethers.deployContract('MockPancakeRouter', [mockFactory.target])
    const graduator: Contract = await ethers.deployContract('OakenFlapGraduatorV2', [
      deployer.address, router.target, WBNB,
    ])
    await as(graduator, deployer).bindFactory(factory.address)
    const curve: Contract = await ethers.deployContract('MockCurveRef', [factory.address])

    const token: Contract = await ethers.deployContract('OakenTaxToken', [[
      'Graduating Tax', 'GTX', SUPPLY, deployer.address, factory.address, graduator.target, creator.address,
      [100, 100, 3600, 10000, 0, 0, 0, protocol.address, ethers.ZeroAddress, ethers.ZeroAddress, protocol.address],
    ]])
    await as(token, deployer).transfer(graduator.target, TOKEN_AMOUNT)

    await as(curve, creator).callGraduate(graduator.target, token.target, TOKEN_AMOUNT, QUOTE, { value: QUOTE })

    expect(await router.called()).to.equal(true)
    expect(await router.lastToken()).to.equal(token.target)
    expect(await router.lastTokenDesired()).to.equal(TOKEN_AMOUNT)
    expect(await router.lastValue()).to.equal(QUOTE)
    expect(await router.lastTo()).to.equal(graduator.target)
    expect(await token.isPool(pool.address)).to.equal(true)
    expect(await token.taxStart()).to.be.greaterThan(0n)

    const names = Object.keys(graduator.interface.fragments.reduce((acc: Record<string, true>, f: any) => {
      if (f.type === 'function') acc[f.name] = true
      return acc
    }, {}))
    expect(names.filter((n) => /transfer|rescue|withdraw|execute/i.test(n))).to.deep.equal([])
  })

  it('V2 rejects a curve from another factory and a wrong value', async () => {
    const [deployer, factory, other, pool] = await ethers.getSigners()
    const mockFactory: Contract = await ethers.deployContract('MockPancakeFactory', [pool.address])
    const router: Contract = await ethers.deployContract('MockPancakeRouter', [mockFactory.target])
    const graduator: Contract = await ethers.deployContract('OakenFlapGraduatorV2', [
      deployer.address, router.target, WBNB,
    ])
    await as(graduator, deployer).bindFactory(factory.address)
    const curve: Contract = await ethers.deployContract('MockCurveRef', [factory.address])
    const foreign: Contract = await ethers.deployContract('MockCurveRef', [other.address])
    await expect(
      as(foreign, other).callGraduate(graduator.target, other.address, 1, QUOTE, { value: QUOTE }),
    ).to.be.revertedWithCustomError(graduator, 'NotCurve')
    await expect(
      as(curve, other).callGraduate(graduator.target, other.address, 1, QUOTE, { value: QUOTE - 1n }),
    ).to.be.revertedWithCustomError(graduator, 'WrongValue')
  })

  it('V3 mints a full-range token/WBNB position to itself', async () => {
    const [deployer, factory, creator] = await ethers.getSigners()
    const npm: Contract = await ethers.deployContract('MockPancakeV3PositionManager')
    const graduator: Contract = await ethers.deployContract('OakenFlapGraduatorV3', [
      deployer.address, npm.target, WBNB, 2500, 50,
    ])
    await as(graduator, deployer).bindFactory(factory.address)
    const curve: Contract = await ethers.deployContract('MockCurveRef', [factory.address])
    const token: Contract = await ethers.deployContract('OakenToken', [
      'Graduating Standard', 'GST', 18, SUPPLY, deployer.address,
    ])
    await as(token, deployer).transfer(graduator.target, TOKEN_AMOUNT)

    await as(curve, creator).callGraduate(graduator.target, token.target, TOKEN_AMOUNT, QUOTE, { value: QUOTE })

    const tokenIs0 = String(token.target).toLowerCase() < WBNB.toLowerCase()
    expect(await npm.called()).to.equal(true)
    expect(await npm.token0()).to.equal(tokenIs0 ? token.target : WBNB)
    expect(await npm.token1()).to.equal(tokenIs0 ? WBNB : token.target)
    expect(await npm.fee()).to.equal(2500n)
    expect(await npm.tickLower()).to.equal(-887250n)
    expect(await npm.tickUpper()).to.equal(887250n)
    expect(await npm.amount0Desired()).to.equal(tokenIs0 ? TOKEN_AMOUNT : QUOTE)
    expect(await npm.amount1Desired()).to.equal(tokenIs0 ? QUOTE : TOKEN_AMOUNT)
    expect(await npm.recipient()).to.equal(graduator.target)
    expect(await npm.lastValue()).to.equal(QUOTE)
    expect(await graduator.onERC721Received.staticCall(ethers.ZeroAddress, ethers.ZeroAddress, 1, '0x'))
      .to.equal('0x150b7a02')
  })
})
