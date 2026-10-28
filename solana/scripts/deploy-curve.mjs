// Deploy the OAKEN Curve program and make it immutable, with an explicit
// funding check first. Dry run unless EXECUTE=1:
//
//   node scripts/deploy-curve.mjs                 # estimate + balance, no send
//   EXECUTE=1 node scripts/deploy-curve.mjs       # real deploy (needs ~2x rent)
//
// Behind a proxy (this dev machine): set PROXY for the web3 connection and
// HTTPS_PROXY/HTTP_PROXY for the Solana CLI, e.g.
//   PROXY=http://127.0.0.1:12000 HTTPS_PROXY=http://127.0.0.1:12000 \
//   HTTP_PROXY=http://127.0.0.1:12000 EXECUTE=1 node scripts/deploy-curve.mjs
//
// The upgradeable loader writes the program into a buffer account and then
// copies it into ProgramData. Both rent deposits exist at the same time, so the
// wallet must hold roughly **twice** the final ProgramData rent; the buffer's
// lamports come back after the deploy. `--final` sets the upgrade authority to
// none during the deploy (irreversible).
//
// After deploying, this script reads the program bytes back from ProgramData,
// hashes them, and compares with target/deploy/oaken_curve.so. It writes
// curve-deploy-evidence.json next to _live-*-evidence.json.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const BIN = process.env.SOLANA_BIN || path.join(os.homedir(), '.local', 'share', 'solana', 'install', 'active_release', 'bin')
const CLI = path.join(BIN, process.platform === 'win32' ? 'solana.exe' : 'solana')
const SO = path.join(ROOT, 'target', 'deploy', 'oaken_curve.so')
const PROGRAM_KEYPAIR = path.join(ROOT, 'curve-program-keypair.json')
const WALLET = process.env.WALLET || path.join(os.homedir(), '.config', 'solana', 'id.json')
const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
const EXECUTE = process.env.EXECUTE === '1'
const LAMPORTS_PER_SOL = 1_000_000_000

// Node's fetch does not honour HTTPS_PROXY; the CLI does. When PROXY is set,
// route the web3 connection through the same local proxy.
let fetchImpl = globalThis.fetch
let proxyAgent = null
if (process.env.PROXY) {
  const undiciPath = path.resolve(ROOT, '..', 'contracts', 'node_modules', 'undici', 'index.js')
  const undici = await import(pathToFileURL(undiciPath).href)
  proxyAgent = new undici.ProxyAgent(process.env.PROXY)
  fetchImpl = undici.fetch
}

function cli(args) {
  return execFileSync(CLI, args, { encoding: 'utf8' }).trim()
}
/** Rent-exempt minimum: (data_len + 128) * 3480 lamports/byte-year * 2 years. */
function minimumBalance(bytes) {
  return (bytes + 128) * 6960
}

(async () => {
  if (!fs.existsSync(SO)) throw new Error('missing ' + SO + ' — run cargo-build-sbf first')
  if (!fs.existsSync(PROGRAM_KEYPAIR)) throw new Error('missing ' + PROGRAM_KEYPAIR)
  const programKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(PROGRAM_KEYPAIR, 'utf8'))))
  const declared = fs.readFileSync(path.join(ROOT, 'curve-program', 'src', 'lib.rs'), 'utf8')
    .match(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/)
  if (!declared) throw new Error('declare_id! not found in lib.rs')
  if (declared[1] !== programKp.publicKey.toBase58()) {
    throw new Error(`declare_id ${declared[1]} != program keypair ${programKp.publicKey.toBase58()}`)
  }

  const so = fs.readFileSync(SO)
  const sha = createHash('sha256').update(so).digest('hex')
  const programRent = minimumBalance(36)
  const dataRent = minimumBalance(so.length + 45) // ProgramData: 45-byte header
  const bufferRent = minimumBalance(so.length + 37) // Buffer: 37-byte header
  const total = programRent + dataRent + bufferRent
  const conn = new Connection(RPC, {
    commitment: 'confirmed',
    ...(process.env.PROXY
      ? {
          fetch: (u, o) => fetchImpl(u, { ...o, dispatcher: proxyAgent }),
        }
      : {}),
  })
  const walletKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET, 'utf8'))))
  const balance = await conn.getBalance(walletKp.publicKey)

  console.log(`program   ${programKp.publicKey.toBase58()}`)
  console.log(`wallet    ${walletKp.publicKey.toBase58()}  ${balance / LAMPORTS_PER_SOL} SOL`)
  console.log(`binary    ${so.length} bytes  sha256 ${sha}`)
  console.log(`rent      program ${programRent / LAMPORTS_PER_SOL} + programdata ${dataRent / LAMPORTS_PER_SOL} + buffer ${bufferRent / LAMPORTS_PER_SOL}`)
  console.log(`peak need ${total / LAMPORTS_PER_SOL} SOL (buffer comes back; final cost ~${(programRent + dataRent) / LAMPORTS_PER_SOL})`)
  if (balance < total) {
    console.log(`\n❌ short by ${(total - balance) / LAMPORTS_PER_SOL} SOL — not deploying`)
    process.exit(2)
  }
  if (!EXECUTE) {
    console.log('\nDry run. Set EXECUTE=1 to deploy with --final.')
    return
  }

  console.log('\nDeploying…')
  const out = cli([
    'program', 'deploy', SO,
    '--program-id', PROGRAM_KEYPAIR,
    '--keypair', WALLET,
    '--url', RPC,
    '--final',
    '--use-rpc',
  ])
  console.log(out)

  const info = JSON.parse(cli(['program', 'show', programKp.publicKey.toBase58(), '--url', RPC, '--output', 'json']))
  const shownAuthority = info.authority ?? info.upgradeAuthority ?? null
  if (shownAuthority && shownAuthority !== 'none' && shownAuthority !== '11111111111111111111111111111111') {
    console.log(`⚠ authority is ${shownAuthority}; setting it to none…`)
    console.log(cli(['program', 'set-upgrade-authority', programKp.publicKey.toBase58(), '--final', '--keypair', WALLET, '--url', RPC]))
  }

  // Read ProgramData back and hash its program bytes.
  const programAccount = await conn.getAccountInfo(programKp.publicKey)
  if (!programAccount?.executable) throw new Error('program account is not executable after deploy')
  const [programDataAddress] = PublicKey.findProgramAddressSync(
    [programKp.publicKey.toBuffer()],
    new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),
  )
  const pd = await conn.getAccountInfo(programDataAddress)
  if (!pd) throw new Error('ProgramData account not found')
  // ProgramData layout: u32 tag, u64 slot, Option<Pubkey> authority (1 + 32),
  // then the program bytes. A `--final` deploy stores None, so the header is 13.
  const optionTag = pd.data[12]
  const header = optionTag === 0 ? 13 : 45
  const onchain = pd.data.subarray(header, header + so.length)
  const onchainSha = createHash('sha256').update(onchain).digest('hex')
  if (onchainSha !== sha) throw new Error(`on-chain sha ${onchainSha} != local ${sha}`)
  const authority = optionTag === 0 ? 'none' : new PublicKey(pd.data.subarray(13, 45)).toBase58()
  if (authority !== 'none' && authority !== '11111111111111111111111111111111') {
    throw new Error(`upgrade authority is still ${authority}`)
  }

  const evidence = {
    at: new Date().toISOString(),
    cluster: RPC,
    programId: programKp.publicKey.toBase58(),
    programData: programDataAddress.toBase58(),
    deploySlot: await conn.getSlot(),
    authority: 'none',
    bytes: so.length,
    sha256: sha,
    rentLamports: { program: programRent, programData: dataRent, buffer: bufferRent },
    deployer: walletKp.publicKey.toBase58(),
  }
  const outFile = path.join(ROOT, 'curve-deploy-evidence.json')
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n')
  console.log('\n✅ deployed, immutable, bytes match:', outFile)
})().catch((e) => { console.error('❌', e.message || e); process.exit(1) })
