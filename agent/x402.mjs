/**
 * x402 v1 / exact / EIP-3009 for USDG on Robinhood Chain.
 *
 * This is the same wire format hood402 speaks (`X-PAYMENT`, base64 JSON,
 * `eip155`-style network id `robinhood`, USDG asset, EIP-712 domain
 * `Global Dollar` / `1`). It is a small, dependency-light implementation for
 * the OAKEN report service, not a replacement for the hood402 facilitator.
 *
 * The beta runs with payment off. The code path is here so the paid mode is a
 * configuration change, not a rewrite.
 */

import { ethers } from './ethers.mjs'
import { rpc, readUint } from '../src/rpc.mjs'

export const X402_VERSION = 1
export const SCHEME = 'exact'
export const NETWORK = 'robinhood'
export const NETWORK_CAIP2 = 'eip155:4663'
export const CHAIN_ID = 4663
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
export const USDG_DECIMALS = 6
export const USDG_DOMAIN = { name: 'Global Dollar', version: '1', chainId: CHAIN_ID, verifyingContract: USDG }
export const PAYMENT_HEADER = 'X-PAYMENT'
export const PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE'
export const DEFAULT_RHC_RPC = 'https://rpc.mainnet.chain.robinhood.com'

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

const AUTH_STATE_SELECTOR = '0xe94a0102'
const BALANCE_OF_SELECTOR = '0x70a08231'
const TRANSFER_WITH_AUTHORIZATION = new ethers.Interface([
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
])

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const REASON_TEXT = {
  malformed_payment: 'The payment payload is malformed.',
  invalid_scheme: 'The payment scheme is not exact.',
  unsupported_network: 'The payment network is not supported.',
  network_mismatch: 'The payment network does not match the requirement.',
  invalid_asset: 'The payment asset is not USDG on Robinhood Chain.',
  invalid_recipient: 'The payment recipient does not match the requirement.',
  insufficient_amount: 'The payment amount is below the required price.',
  authorization_expired: 'The authorization has expired.',
  authorization_not_yet_valid: 'The authorization is not valid yet.',
  invalid_signature: 'The EIP-3009 signature does not recover to the payer.',
  authorization_already_used: 'This authorization nonce has already been settled.',
  insufficient_balance: 'The payer does not have enough USDG.',
  facilitator_not_configured: 'The facilitator key is not configured.',
  settlement_failed: 'The settlement transaction failed.',
}

function addressWord(address) {
  return String(address).toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

function toAtomic(price) {
  return ethers.parseUnits(String(price), USDG_DECIMALS).toString()
}

export function randomNonce() {
  return ethers.hexlify(ethers.randomBytes(32))
}

export function buildRequirements({ price, payTo, resource, description = '', maxTimeoutSeconds = 300 }) {
  if (!ethers.isAddress(payTo)) throw new Error('payTo must be an address')
  return {
    scheme: SCHEME,
    network: NETWORK,
    maxAmountRequired: toAtomic(price),
    resource,
    description,
    mimeType: 'application/json',
    payTo: ethers.getAddress(payTo),
    maxTimeoutSeconds,
    asset: USDG,
    extra: { name: USDG_DOMAIN.name, version: USDG_DOMAIN.version },
  }
}

export function buildPaymentRequired(accepts, error) {
  return {
    x402Version: X402_VERSION,
    accepts: Array.isArray(accepts) ? accepts : [accepts],
    ...(error ? { error } : {}),
  }
}

export function isWellFormedPayload(value) {
  if (!value || typeof value !== 'object') return false
  if (value.x402Version !== X402_VERSION) return false
  if (value.scheme !== SCHEME) return false
  if (typeof value.network !== 'string') return false
  const inner = value.payload
  if (!inner || typeof inner !== 'object') return false
  if (typeof inner.signature !== 'string') return false
  const auth = inner.authorization
  if (!auth || typeof auth !== 'object') return false
  for (const key of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']) {
    if (typeof auth[key] !== 'string') return false
  }
  if (!ethers.isAddress(auth.from) || !ethers.isAddress(auth.to)) return false
  return true
}

export function parsePaymentHeader(headerValue) {
  if (typeof headerValue !== 'string' || !headerValue.trim()) return null
  try {
    const json = Buffer.from(headerValue.trim(), 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    return isWellFormedPayload(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function encodePaymentResponse(result) {
  return Buffer.from(JSON.stringify(result), 'utf8').toString('base64')
}

export function validateStructural(payload, requirements, now = Math.floor(Date.now() / 1000)) {
  if (!isWellFormedPayload(payload)) return { isValid: false, invalidReason: 'malformed_payment' }
  if (payload.scheme !== requirements.scheme) return { isValid: false, invalidReason: 'invalid_scheme' }
  if (payload.network !== requirements.network) return { isValid: false, invalidReason: 'network_mismatch' }
  if (String(requirements.asset).toLowerCase() !== USDG.toLowerCase()) return { isValid: false, invalidReason: 'invalid_asset' }

  const auth = payload.payload.authorization
  if (String(auth.to).toLowerCase() !== String(requirements.payTo).toLowerCase()) {
    return { isValid: false, invalidReason: 'invalid_recipient' }
  }

  let value
  let required
  let validAfter
  let validBefore
  try {
    value = BigInt(auth.value)
    required = BigInt(requirements.maxAmountRequired)
    validAfter = BigInt(auth.validAfter)
    validBefore = BigInt(auth.validBefore)
  } catch {
    return { isValid: false, invalidReason: 'malformed_payment' }
  }
  if (value < required) return { isValid: false, invalidReason: 'insufficient_amount' }
  if (validBefore <= BigInt(now)) return { isValid: false, invalidReason: 'authorization_expired' }
  if (validAfter > BigInt(now)) return { isValid: false, invalidReason: 'authorization_not_yet_valid' }

  return { isValid: true, payer: ethers.getAddress(auth.from) }
}

export function verifySignature(payload) {
  try {
    const auth = payload.payload.authorization
    const recovered = ethers.verifyTypedData(
      USDG_DOMAIN,
      TRANSFER_WITH_AUTHORIZATION_TYPES,
      {
        from: ethers.getAddress(auth.from),
        to: ethers.getAddress(auth.to),
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      payload.payload.signature,
    )
    return String(recovered).toLowerCase()
  } catch {
    return null
  }
}

async function authorizationState(from, nonce) {
  const data = AUTH_STATE_SELECTOR + addressWord(from) + nonce.replace(/^0x/, '').padStart(64, '0')
  const result = await rpc(CHAIN_ID, 'eth_call', [{ to: USDG, data }, 'latest'], { timeout: 20_000, attempts: 3 })
  return readUint(result, 0) !== 0n
}

async function balanceOf(address) {
  const data = BALANCE_OF_SELECTOR + addressWord(address)
  const result = await rpc(CHAIN_ID, 'eth_call', [{ to: USDG, data }, 'latest'], { timeout: 20_000, attempts: 3 })
  return readUint(result, 0)
}

/**
 * Full verification: shape → signature → on-chain replay → on-chain balance.
 * `skipOnchain` exists for deterministic unit tests; the HTTP path never uses it.
 */
export async function verifyPayment(headerValue, requirements, options = {}) {
  const payload = parsePaymentHeader(headerValue)
  if (!payload) return { isValid: false, invalidReason: 'malformed_payment' }

  const structural = validateStructural(payload, requirements, options.now)
  if (!structural.isValid) return structural

  const recovered = verifySignature(payload)
  if (!recovered || recovered !== String(payload.payload.authorization.from).toLowerCase()) {
    return { isValid: false, invalidReason: 'invalid_signature' }
  }

  if (!options.skipOnchain) {
    const auth = payload.payload.authorization
    try {
      const [used, balance] = await Promise.all([
        authorizationState(auth.from, auth.nonce),
        balanceOf(auth.from),
      ])
      if (used) return { isValid: false, invalidReason: 'authorization_already_used' }
      if (balance < BigInt(auth.value)) return { isValid: false, invalidReason: 'insufficient_balance' }
    } catch (error) {
      return { isValid: false, invalidReason: 'malformed_payment', detail: String(error?.message || error) }
    }
  }

  return { isValid: true, payer: recovered, payload }
}

/**
 * Settle a verified authorization by broadcasting `transferWithAuthorization`
 * from the facilitator wallet. The facilitator pays gas; it never holds user
 * funds. `gasLimit` is explicit because Robinhood Chain's estimate is unreliable.
 */
export async function settlePayment(payload, options = {}) {
  // The same module runs on Node and in the report Worker; Workers has no
  // process.env, and callers there pass the key explicitly.
  const runtimeEnv = typeof process !== 'undefined' && process.env ? process.env : {}
  const privateKey = options.privateKey || runtimeEnv.AGENT_FACILITATOR_KEY
  if (!privateKey) {
    return { success: false, errorReason: 'facilitator_not_configured', network: NETWORK, payer: payload?.payload?.authorization?.from }
  }
  const payer = payload?.payload?.authorization?.from
  try {
    /* Sign locally and broadcast through the same fallback RPC list the reads
       use. `ethers.JsonRpcProvider` would pin settlement to the official
       endpoint, which answers Cloudflare's egress with 429 — the very reason
       report generation has a fallback list. The facilitator pays gas; it
       never holds user funds. */
    const wallet = new ethers.Wallet(privateKey)
    const auth = payload.payload.authorization
    const signature = ethers.Signature.from(payload.payload.signature)
    const data = TRANSFER_WITH_AUTHORIZATION.encodeFunctionData('transferWithAuthorization', [
      ethers.getAddress(auth.from),
      ethers.getAddress(auth.to),
      BigInt(auth.value),
      BigInt(auth.validAfter),
      BigInt(auth.validBefore),
      auth.nonce,
      signature.v,
      signature.r,
      signature.s,
    ])

    const nonce = Number(BigInt(await rpc(CHAIN_ID, 'eth_getTransactionCount', [wallet.address, 'pending'], { timeout: 20_000, attempts: 5 })))
    const block = await rpc(CHAIN_ID, 'eth_getBlockByNumber', ['latest', false], { timeout: 20_000, attempts: 5 })
    const baseFee = BigInt(block?.baseFeePerGas || 0)
    /* Robinhood Chain is EIP-1559. A legacy gasPrice from eth_gasPrice can sit
       a few wei under the next block's base fee (observed: 20.116 vs 20.278
       gwei) and the node rejects the tx. Max fee = 3× base + 0.001 gwei tip is
       ample and still costs micro-ETH for 300k gas. */
    const fees = baseFee > 0n
      ? { maxFeePerGas: baseFee * 3n + 1_000_000n, maxPriorityFeePerGas: 1_000_000n }
      : { gasPrice: (BigInt(await rpc(CHAIN_ID, 'eth_gasPrice', [], { timeout: 20_000, attempts: 5 })) * 12n) / 10n }
    const gasLimit = 300_000n
    const maxCost = (fees.maxFeePerGas || fees.gasPrice) * gasLimit
    const balance = BigInt(await rpc(CHAIN_ID, 'eth_getBalance', [wallet.address, 'latest'], { timeout: 20_000, attempts: 5 }))
    if (balance < maxCost) {
      return {
        success: false,
        errorReason: 'facilitator_not_configured',
        detail: `facilitator ${wallet.address} has ${ethers.formatEther(balance)} ETH; a settlement needs up to ${ethers.formatEther(maxCost)} ETH`,
        network: NETWORK,
        payer,
      }
    }

    const raw = await wallet.signTransaction({
      to: USDG,
      data,
      chainId: CHAIN_ID,
      nonce,
      gasLimit,
      ...fees,
      value: 0n,
    })

    let hash
    try {
      hash = await rpc(CHAIN_ID, 'eth_sendRawTransaction', [raw], { timeout: 30_000, attempts: 6 })
    } catch (error) {
      const message = String(error?.message || error)
      if (/already known|known transaction|alreadyknown/i.test(message)) {
        hash = ethers.keccak256(raw)
      } else {
        /* One endpoint can accept the tx and another can answer with an error
           first. The signed hash is deterministic, so if the authorization
           nonce is now used, keep polling instead of reporting a failure. */
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const used = await authorizationState(auth.from, auth.nonce).catch(() => false)
        if (!used) throw error
        hash = ethers.keccak256(raw)
      }
    }

    for (let i = 0; i < 45; i++) {
      const receipt = await rpc(CHAIN_ID, 'eth_getTransactionReceipt', [hash], { timeout: 15_000, attempts: 2 }).catch(() => null)
      if (receipt) {
        if (String(receipt.status) === '0x1') {
          return {
            success: true,
            transaction: receipt.transactionHash || hash,
            network: NETWORK,
            payer: ethers.getAddress(auth.from),
          }
        }
        return {
          success: false,
          errorReason: 'settlement_failed',
          detail: `transaction ${hash} reverted`,
          transaction: hash,
          network: NETWORK,
          payer,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    /* No receipt from any endpoint. EIP-3009 marks the nonce before it moves
       funds, so a used nonce means the transfer landed even if the receipt
       read is the thing that is failing. */
    try {
      if (await authorizationState(auth.from, auth.nonce)) {
        return { success: true, transaction: hash, network: NETWORK, payer: ethers.getAddress(auth.from) }
      }
    } catch { /* fall through to the honest failure */ }

    return {
      success: false,
      errorReason: 'settlement_failed',
      detail: `no receipt for ${hash} after 45s`,
      transaction: hash,
      network: NETWORK,
      payer,
    }
  } catch (error) {
    return {
      success: false,
      errorReason: 'settlement_failed',
      detail: String(error?.message || error).slice(0, 300),
      network: NETWORK,
      payer,
    }
  }
}

export function reasonText(reason) {
  return REASON_TEXT[reason] || reason || 'Payment failed.'
}

export { ZERO_ADDRESS }
