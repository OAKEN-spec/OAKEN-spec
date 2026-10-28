/**
 * One-time ops: the treasury that receives report payments and the facilitator
 * that pays settlement gas. Keys live under `_secrets/` (the project is not a
 * git repo); this script prints addresses only.
 *
 *   node agent/setup-wallets.mjs            # create if missing, top up gas if low
 *   node agent/setup-wallets.mjs --force    # replace both wallets (danger)
 *
 * The treasury only ever needs its address in the service; its key is kept so
 * the funds can be moved later. The facilitator key is set as a Worker secret.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ethers } from './ethers.mjs'
import { rpc } from '../src/rpc.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const secrets = path.join(root, '_secrets')
const walletFile = path.join(secrets, 'agent-wallets.json')
const siteKeyFile = path.join(secrets, 'agent-site-key.txt')
const force = process.argv.includes('--force')

const TOPUP = ethers.parseEther('0.00003')
const MIN_GAS = ethers.parseEther('0.00003')

fs.mkdirSync(secrets, { recursive: true })

function siteKey() {
  if (fs.existsSync(siteKeyFile) && !force) return fs.readFileSync(siteKeyFile, 'utf8').trim()
  const key = ethers.hexlify(ethers.randomBytes(32))
  fs.writeFileSync(siteKeyFile, key + '\n')
  return key
}

let wallets
if (fs.existsSync(walletFile) && !force) {
  wallets = JSON.parse(fs.readFileSync(walletFile, 'utf8'))
} else {
  const treasury = ethers.Wallet.createRandom()
  const facilitator = ethers.Wallet.createRandom()
  wallets = {
    createdAt: new Date().toISOString(),
    note: 'OAKEN Agent Reports: treasury receives report payments; facilitator pays settlement gas and holds no user funds.',
    treasury: { address: treasury.address, privateKey: treasury.privateKey },
    facilitator: { address: facilitator.address, privateKey: facilitator.privateKey },
  }
  fs.writeFileSync(walletFile, JSON.stringify(wallets, null, 2) + '\n')
  console.log('created', walletFile)
}

const env = fs.readFileSync(path.join(root, '.env'), 'utf8')
const deployerKey = env.match(/^DEPLOYER_KEY=(.+)$/m)?.[1]?.trim()
if (!deployerKey) throw new Error('DEPLOYER_KEY missing from .env')
const deployer = new ethers.Wallet(deployerKey)

const facilitator = new ethers.Wallet(wallets.facilitator.privateKey)
const treasury = new ethers.Wallet(wallets.treasury.privateKey)

const eth = async (address) => BigInt(await rpc(4663, 'eth_getBalance', [address, 'latest']))
const facilitatorBalance = await eth(facilitator.address)
console.log('deployer   ', deployer.address, ethers.formatEther(await eth(deployer.address)), 'ETH')
console.log('treasury   ', treasury.address, ethers.formatEther(await eth(treasury.address)), 'ETH')
console.log('facilitator', facilitator.address, ethers.formatEther(facilitatorBalance), 'ETH')

if (facilitatorBalance < MIN_GAS) {
  const nonce = Number(BigInt(await rpc(4663, 'eth_getTransactionCount', [deployer.address, 'pending'])))
  const block = await rpc(4663, 'eth_getBlockByNumber', ['latest', false])
  const baseFee = BigInt(block?.baseFeePerGas || 0)
  const fees = baseFee > 0n
    ? { maxFeePerGas: baseFee * 3n + 1_000_000n, maxPriorityFeePerGas: 1_000_000n }
    : { gasPrice: (BigInt(await rpc(4663, 'eth_gasPrice', [])) * 12n) / 10n }
  const raw = await deployer.signTransaction({
    to: facilitator.address,
    value: TOPUP,
    chainId: 4663,
    nonce,
    gasLimit: 30_000n,
    ...fees,
  })
  const hash = await rpc(4663, 'eth_sendRawTransaction', [raw], { attempts: 5 })
  for (let i = 0; i < 30; i++) {
    const receipt = await rpc(4663, 'eth_getTransactionReceipt', [hash], { attempts: 2 }).catch(() => null)
    if (receipt) {
      console.log('funded facilitator', hash, 'status', receipt.status)
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  console.log('facilitator now', ethers.formatEther(await eth(facilitator.address)), 'ETH')
} else {
  console.log('facilitator already funded; no top-up')
}

const sk = siteKey()
console.log('site key   ', sk.slice(0, 8) + '…', `(${siteKeyFile})`)
