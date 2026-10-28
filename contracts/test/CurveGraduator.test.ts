import { expect } from 'chai'
import { ethers } from 'hardhat'
import { as, loadFixture } from './helpers'
import type { Contract } from 'ethers'

/**
 * The V4 graduation adapter: pool initialization at launch, the one-shot
 * full-range mint, the hook that keeps anyone else out of the pool before
 * graduation, and the exact math the position is built from.
 */
describe('OakenCurveGraduatorV4', () => {
  const Q96 = 1n << 96n
  const SUPPLY = ethers.parseEther('1000000000')
  const PHANTOM = ethers.parseEther('1.68')
  const THRESHOLD = ethers.parseEther('4.2')
  const TOKEN_AMOUNT = (SUPPLY * PHANTOM) / (PHANTOM + THRESHOLD)
  const QUOTE = THRESHOLD
  const SQRT_LOWER = 4310618291n
  const SQRT_UPPER = 1456195216270955103182949462556801019286893565306n
  const ZERO = ethers.ZeroAddress

  function isqrt(n: bigint): bigint {
    if (n < 2n) return n
    let x = n
    let y = (x + 1n) / 2n
    while (y < x) {
      x = y
      y = (x + n / x) / 2n
    }
    return x
  }
  const sqrtP = isqrt((TOKEN_AMOUNT * (1n << 192n)) / QUOTE)
  const liq0 = (a: bigint, b: bigint, amount0: bigint) => {
    const [lo, hi] = a < b ? [a, b] : [b, a]
    const intermediate = (lo * hi) / Q96
    return (amount0 * intermediate) / (hi - lo)
  }
  const liq1 = (a: bigint, b: bigint, amount1: bigint) => {
    const [lo, hi] = a < b ? [a, b] : [b, a]
    return (amount1 * Q96) / (hi - lo)
  }
  const liquidity = (() => {
    const l0 = liq0(sqrtP, SQRT_UPPER, QUOTE)
    const l1 = liq1(SQRT_LOWER, sqrtP, TOKEN_AMOUNT)
    return l0 < l1 ? l0 : l1
  })()

  const SEL_BEFORE_INIT = ethers.id(
    'beforeInitialize(address,(address,address,uint24,int24,address),uint160)',
  ).slice(0, 10)
  const SEL_BEFORE_ADD = ethers.id(
    'beforeAddLiquidity(address,(address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)',
  ).slice(0, 10)

  async function fixture() {
    const [deployer, factorySigner, alice, bob] = await ethers.getSigners()
    const poolManager: Contract = await ethers.deployContract('MockV4PoolManager')
    const positionManager: Contract = await ethers.deployContract('MockV4PositionManager')
    const permit2: Contract = await ethers.deployContract('MockPermit2')
    const graduator: Contract = await ethers.deployContract('OakenCurveGraduatorV4', [
      deployer.address,
      poolManager.target,
      positionManager.target,
      permit2.target,
      0, // pool fee
      200, // tick spacing
      SQRT_LOWER,
      SQRT_UPPER,
    ])
    await as(graduator, deployer).bindFactory(factorySigner.address)
    const curve: Contract = await ethers.deployContract('MockCurveRef', [factorySigner.address])
    const foreignCurve: Contract = await ethers.deployContract('MockCurveRef', [bob.address])
    const token: Contract = await ethers.deployContract('OakenToken', [
      'Graduation Test', 'GRD', 18, SUPPLY, alice.address,
    ])
    await as(token, alice).transfer(graduator.target, TOKEN_AMOUNT)
    const math: Contract = await ethers.deployContract('GraduationMathHarness')
    const key = [ZERO, token.target, 0, 200, graduator.target] as const
    const poolId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(address,address,uint24,int24,address)'], [key],
      ),
    )
    return { poolManager, positionManager, permit2, graduator, curve, foreignCurve, token, math,
      deployer, factorySigner, alice, bob, key, poolId }
  }

  it('computes the opening price and full-range liquidity exactly', async () => {
    const { math } = await loadFixture(fixture)
    expect(await math.sqrtPriceX96FromAmounts(QUOTE, TOKEN_AMOUNT)).to.equal(sqrtP)
    expect(await math.liquidityForAmounts(sqrtP, SQRT_LOWER, SQRT_UPPER, QUOTE, TOKEN_AMOUNT))
      .to.equal(liquidity)
    expect(liquidity).to.be.greaterThan(0n)
    expect(liquidity).to.be.lessThan(2n ** 128n)
  })

  it('initializes the pool at launch with the graduation price and our hook', async () => {
    const { graduator, poolManager, token, factorySigner, alice } = await loadFixture(fixture)
    await as(graduator, factorySigner).initializePool(token.target, QUOTE, TOKEN_AMOUNT)
    expect(await poolManager.initialized()).to.equal(true)
    expect(await poolManager.lastCurrency0()).to.equal(ZERO)
    expect(await poolManager.lastCurrency1()).to.equal(token.target)
    expect(await poolManager.lastFee()).to.equal(0n)
    expect(await poolManager.lastTickSpacing()).to.equal(200n)
    expect(await poolManager.lastHooks()).to.equal(graduator.target)
    expect(await poolManager.lastSqrtPriceX96()).to.equal(sqrtP)
    await expect(as(graduator, alice).initializePool(token.target, QUOTE, TOKEN_AMOUNT))
      .to.be.revertedWithCustomError(graduator, 'NotFactory')
  })

  it('only lets the graduator initialize, and keeps adds out until graduation', async () => {
    const { graduator, poolManager, positionManager, token, key } = await loadFixture(fixture)
    const params = [-887200, 887200, 0, ethers.ZeroHash]
    expect(await poolManager.callBeforeInitialize.staticCall(graduator.target, graduator.target, key, sqrtP))
      .to.equal(SEL_BEFORE_INIT)
    expect(await poolManager.callBeforeInitialize.staticCall(graduator.target, token.target, key, sqrtP))
      .to.equal('0x00000000')
    expect(
      await poolManager.callBeforeAddLiquidity.staticCall(
        graduator.target, positionManager.target, key, params, '0x',
      ),
    ).to.equal('0x00000000')
  })

  it('mints one full-range position, keeps the NFT, and opens the pool', async () => {
    const { graduator, poolManager, positionManager, permit2, curve, token, factorySigner, alice, key, poolId } =
      await loadFixture(fixture)
    await as(graduator, factorySigner).initializePool(token.target, QUOTE, TOKEN_AMOUNT)
    await as(curve, alice).callGraduate(graduator.target, token.target, TOKEN_AMOUNT, QUOTE, { value: QUOTE })

    expect(await positionManager.called()).to.equal(true)
    expect(await positionManager.lastValue()).to.equal(QUOTE)
    expect(await positionManager.currency0()).to.equal(ZERO)
    expect(await positionManager.currency1()).to.equal(token.target)
    expect(await positionManager.hooks()).to.equal(graduator.target)
    expect(await positionManager.tickLower()).to.equal(-887200n)
    expect(await positionManager.tickUpper()).to.equal(887200n)
    expect(await positionManager.liquidity()).to.equal(liquidity)
    expect(await positionManager.amount0Max()).to.equal(QUOTE)
    expect(await positionManager.amount1Max()).to.equal(TOKEN_AMOUNT)
    expect(await positionManager.recipient()).to.equal(graduator.target)

    expect(await permit2.lastToken()).to.equal(token.target)
    expect(await permit2.lastSpender()).to.equal(positionManager.target)
    expect(await permit2.lastAmount()).to.equal(TOKEN_AMOUNT)
    expect(await token.allowance(graduator.target, permit2.target)).to.equal(TOKEN_AMOUNT)

    expect(await graduator.poolGraduated(poolId)).to.equal(true)
    expect(await graduator.poolOpen(poolId)).to.equal(true)
    expect(await graduator.arming()).to.equal(false)

    const params = [-887200, 887200, 0, ethers.ZeroHash]
    expect(
      await poolManager.callBeforeAddLiquidity.staticCall(graduator.target, alice.address, key, params, '0x'),
    ).to.equal(SEL_BEFORE_ADD)
  })

  it('refuses a second graduation for the same pool', async () => {
    const { graduator, curve, token, factorySigner, alice } = await loadFixture(fixture)
    await as(graduator, factorySigner).initializePool(token.target, QUOTE, TOKEN_AMOUNT)
    await as(curve, alice).callGraduate(graduator.target, token.target, TOKEN_AMOUNT, QUOTE, { value: QUOTE })
    await as(token, alice).transfer(graduator.target, TOKEN_AMOUNT)
    await expect(
      as(curve, alice).callGraduate(graduator.target, token.target, TOKEN_AMOUNT, QUOTE, { value: QUOTE }),
    ).to.be.revertedWithCustomError(graduator, 'AlreadyGraduated')
  })

  it('rejects a curve that does not belong to the bound factory, and wrong value', async () => {
    const { graduator, curve, foreignCurve, token, factorySigner, alice } = await loadFixture(fixture)
    await as(graduator, factorySigner).initializePool(token.target, QUOTE, TOKEN_AMOUNT)
    await expect(
      as(foreignCurve, alice).callGraduate(graduator.target, token.target, TOKEN_AMOUNT, QUOTE, { value: QUOTE }),
    ).to.be.revertedWithCustomError(graduator, 'NotCurve')
    await expect(
      as(curve, alice).callGraduate(graduator.target, token.target, TOKEN_AMOUNT, QUOTE, { value: QUOTE - 1n }),
    ).to.be.revertedWithCustomError(graduator, 'WrongValue')
  })

  it('binds the factory once, by the binder only', async () => {
    const { graduator, deployer, alice, bob } = await loadFixture(fixture)
    await expect(as(graduator, bob).bindFactory(bob.address)).to.be.revertedWithCustomError(graduator, 'NotBinder')
    await expect(as(graduator, deployer).bindFactory(bob.address)).to.be.revertedWithCustomError(graduator, 'AlreadyBound')
  })

  it('accepts the position NFT and exposes no way to move it', async () => {
    const { graduator } = await loadFixture(fixture)
    expect(await graduator.onERC721Received.staticCall(ZERO, ZERO, 1, '0x')).to.equal('0x150b7a02')
    const names = Object.keys(graduator.interface.fragments.reduce((acc: Record<string, true>, f: any) => {
      if (f.type === 'function') acc[f.name] = true
      return acc
    }, {}))
    expect(names.filter((n) => /transfer|safeTransfer|rescue|withdraw|execute/i.test(n))).to.deep.equal([])
  })
})
