// Fetch the PumpSwap fixtures the in-process integration test needs:
//   tests/fixtures/pump_amm.so                 (the real AMM ELF)
//   tests/fixtures/pump_global_config.bin      (the real global-config account)
//   tests/fixtures/pump_global_config_lamports.txt
//   tests/fixtures/pump_event_authority_lamports.txt
//
//   node scripts/fetch-pump-fixtures.mjs
//
// The CI workflow runs this before `cargo-test-sbf` so the test is not tied to
// a binary checked into the repository. PROXY=http://127.0.0.1:12000 routes
// the RPC through the local proxy (this machine cannot reach mainnet directly).

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Connection, PublicKey } from '@solana/web3.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'curve-program', 'tests', 'fixtures')
const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
const PUMP = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
const GLOBAL_CONFIG = PublicKey.findProgramAddressSync([Buffer.from('global_config')], PUMP)[0]
const EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP)[0]
const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')

let proxyAgent = null
if (process.env.PROXY) {
  const undiciPath = path.resolve(ROOT, '..', 'contracts', 'node_modules', 'undici', 'index.js')
  const undici = await import(pathToFileURL(undiciPath).href)
  proxyAgent = new undici.ProxyAgent(process.env.PROXY)
  const realFetch = undici.fetch
  globalThis.__fetch = (u, o) => realFetch(u, { ...o, dispatcher: proxyAgent })
}

const conn = new Connection(RPC, {
  commitment: 'confirmed',
  ...(globalThis.__fetch ? { fetch: globalThis.__fetch } : {}),
})

/** End of the ELF file according to its section-header table. */
function elfEnd(buf) {
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error('not an ELF')
  }
  const shoff = Number(buf.readBigUInt64LE(0x28))
  const shentsize = buf.readUInt16LE(0x3a)
  const shnum = buf.readUInt16LE(0x3c)
  const end = shoff + shentsize * shnum
  if (!end || end > buf.length) throw new Error('bad ELF section table')
  return end
}

async function account(pubkey) {
  const info = await conn.getAccountInfo(pubkey)
  if (!info) throw new Error('missing account ' + pubkey.toBase58())
  return info
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  // Program account → ProgramData → ELF
  const program = await account(PUMP)
  let elf
  if (program.owner.equals(BPF_LOADER_UPGRADEABLE)) {
    const programDataAddress = new PublicKey(program.data.subarray(4, 36))
    const pd = await account(programDataAddress)
    const optionTag = pd.data[12]
    const header = optionTag === 0 ? 13 : 45
    elf = pd.data.subarray(header)
  } else {
    elf = program.data
  }
  // `program dump` pads to max_len; trim to the real ELF end.
  const trimmed = elf.subarray(0, elfEnd(elf))
  fs.writeFileSync(path.join(OUT, 'pump_amm.so'), trimmed)
  console.log('pump_amm.so', trimmed.length)

  const gc = await account(GLOBAL_CONFIG)
  fs.writeFileSync(path.join(OUT, 'pump_global_config.bin'), gc.data)
  fs.writeFileSync(path.join(OUT, 'pump_global_config_lamports.txt'), String(gc.lamports))
  fs.writeFileSync(path.join(OUT, 'pump_global_config.json'), JSON.stringify({
    pubkey: GLOBAL_CONFIG.toBase58(), lamports: gc.lamports, owner: gc.owner.toBase58(),
    data: gc.data.toString('base64'),
  }, null, 1) + '\n')
  console.log('pump_global_config.bin', gc.data.length, 'lamports', gc.lamports)

  const ea = await account(EVENT_AUTHORITY)
  fs.writeFileSync(path.join(OUT, 'pump_event_authority_lamports.txt'), String(ea.lamports))
  fs.writeFileSync(path.join(OUT, 'pump_event_authority.json'), JSON.stringify({
    pubkey: EVENT_AUTHORITY.toBase58(), lamports: ea.lamports, owner: ea.owner.toBase58(), data: '',
  }, null, 1) + '\n')
  console.log('event authority lamports', ea.lamports)
}

main().catch((e) => { console.error('ERR', e.message || e); process.exit(1) })
