/**
 * Deploy the OAKEN governance timelock on 4663.
 *
 *   DEPLOYER_KEY=0x… npx hardhat run scripts/deploy-timelock.ts --network robinhood
 *
 * Proposers and cancellers are the 2-of-3 Safe. The Safe must then execute the
 * migration batch (see tools/bonds/safe-timelock-migration.json) to hand the
 * oracle/vault/staking admin over to this contract. Until that batch is signed,
 * the timelock is deployed but inert.
 */
import { ethers } from 'hardhat'

const SAFE = '0x5E8C4c241a29ff7E60c648f378A4AA70053Ee92e'
const DELAY_SEC = 24 * 60 * 60

async function main() {
  const [deployer] = await ethers.getSigners()
  if (!deployer) throw new Error('no signer — set DEPLOYER_KEY')
  console.log(`chain ${(await ethers.provider.getNetwork()).chainId} · deployer ${deployer.address}`)
  const F = await ethers.getContractFactory('OakenTimelock')
  const t = await F.deploy(DELAY_SEC, [SAFE], [SAFE])
  await t.waitForDeployment()
  const address = await t.getAddress()
  const tx = t.deploymentTransaction()
  const receipt = await tx!.wait()
  console.log(JSON.stringify({
    address,
    tx: tx!.hash,
    block: receipt!.blockNumber,
    delaySec: DELAY_SEC,
    proposers: [SAFE],
    cancellers: [SAFE],
  }, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })
