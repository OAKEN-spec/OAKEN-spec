/**
 * Dev-only: deploy the two curve factories on the local Hardhat node, with the
 * mock graduators (no V4/Pancake on 31337). Used by the local UI probes.
 *
 *   npx hardhat run scripts/deploy-curve-local.ts --network localhost
 *
 * Prints the addresses as JSON. The site's `window.OAKEN_CURVE` override points
 * at these; production addresses live in `app/oaken.js` after deployment.
 */
import { ethers } from 'hardhat'

const SUPPLY = ethers.parseEther('1000000000')
const H = ethers.parseEther('107036752')
const R = ethers.parseEther('6.14')

async function main() {
  const [deployer, protocol] = await ethers.getSigners()

  const gradPons: any = await ethers.deployContract('MockCurveGraduator')
  await gradPons.waitForDeployment()
  const factory4663: any = await ethers.deployContract('OakenCurveFactory', [[
    SUPPLY,
    0n,
    ethers.parseEther('1.68'),
    ethers.parseEther('4.2'),
    100n, 1000n, 0n, 9900n, 3n,
    protocol.address,
    gradPons.target,
    protocol.address,
    0n,
  ]])
  await factory4663.waitForDeployment()

  const tokenDeployer: any = await ethers.deployContract('OakenFlapTokenDeployer', [deployer.address])
  await tokenDeployer.waitForDeployment()
  const gradV2: any = await ethers.deployContract('MockCurveGraduator')
  await gradV2.waitForDeployment()
  const gradV3: any = await ethers.deployContract('MockCurveGraduator')
  await gradV3.waitForDeployment()
  const factory56: any = await ethers.deployContract('OakenFlapCurveFactory', [[
    SUPPLY,
    H,
    R,
    ethers.parseEther('16'),
    100n, 1000n, 600n, 9900n, 3n,
    protocol.address,
    gradV3.target,
    gradV2.target,
    tokenDeployer.target,
    protocol.address,
    0n,
  ]])
  await factory56.waitForDeployment()
  await (await tokenDeployer.bindFactory(factory56.target)).wait()
  // The mocks implement graduate()/initializePool() directly; the real Flap
  // graduators also need bindFactory, but the local UI probe only needs the
  // factory + curve path (graduation lands in the mock).

  console.log(JSON.stringify({
    4663: { address: factory4663.target, kind: 'pons' },
    56: { address: factory56.target, kind: 'flap' },
  }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
