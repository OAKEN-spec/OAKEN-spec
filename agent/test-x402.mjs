/**
 * Deterministic x402 tests — no chain, no funds, no facilitator key.
 *
 *   node agent/test-x402.mjs
 *
 * The on-chain replay/balance checks are deliberately skipped here; they are
 * exercised by a real settlement test when a funded facilitator is available.
 * The signature, structure and wire-format checks are the part that can be
 * proven offline, and they are the part most likely to drift.
 */

import assert from 'node:assert/strict'
import { ethers } from './ethers.mjs'

import {
  buildRequirements,
  buildPaymentRequired,
  validateStructural,
  verifySignature,
  verifyPayment,
  parsePaymentHeader,
  encodePaymentResponse,
  settlePayment,
  USDG_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  X402_VERSION,
  SCHEME,
  NETWORK,
  USDG,
  randomNonce,
} from './x402.mjs'

const payTo = '0x7284d41b5b852f2bd4c99bdf95043d84452d299c'
const requirements = buildRequirements({
  price: '0.05',
  payTo,
  resource: 'https://oaken.one/api/agents/report',
  description: 'Token + lock report',
})
assert.equal(requirements.scheme, SCHEME)
assert.equal(requirements.network, NETWORK)
assert.equal(requirements.asset, USDG)
assert.equal(requirements.maxAmountRequired, '50000')
assert.equal(requirements.extra.name, 'Global Dollar')
assert.equal(requirements.extra.version, '1')

const signer = ethers.Wallet.createRandom()
const now = Math.floor(Date.now() / 1000)
const authorization = {
  from: signer.address,
  to: ethers.getAddress(payTo),
  value: requirements.maxAmountRequired,
  validAfter: String(now - 5),
  validBefore: String(now + 300),
  nonce: randomNonce(),
}
const signature = await signer.signTypedData(
  USDG_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  {
    ...authorization,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
  },
)
const payload = {
  x402Version: X402_VERSION,
  scheme: SCHEME,
  network: NETWORK,
  payload: { signature, authorization },
}

const structural = validateStructural(payload, requirements, now)
assert.equal(structural.isValid, true)
assert.equal(structural.payer.toLowerCase(), signer.address.toLowerCase())
assert.equal(verifySignature(payload), signer.address.toLowerCase())

const header = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
assert.deepEqual(parsePaymentHeader(header), payload)
const verified = await verifyPayment(header, requirements, { skipOnchain: true, now })
assert.equal(verified.isValid, true)
assert.equal(verified.payer.toLowerCase(), signer.address.toLowerCase())
console.log('PASS x402 signature and structural checks')

const wrongRecipient = JSON.parse(JSON.stringify(payload))
wrongRecipient.payload.authorization.to = '0x0000000000000000000000000000000000000001'
const badRecipient = validateStructural(wrongRecipient, requirements, now)
assert.equal(badRecipient.isValid, false)
assert.equal(badRecipient.invalidReason, 'invalid_recipient')

const shortAmount = JSON.parse(JSON.stringify(payload))
shortAmount.payload.authorization.value = '1'
const badAmount = validateStructural(shortAmount, requirements, now)
assert.equal(badAmount.isValid, false)
assert.equal(badAmount.invalidReason, 'insufficient_amount')

const expired = JSON.parse(JSON.stringify(payload))
expired.payload.authorization.validBefore = String(now - 1)
const badExpiry = validateStructural(expired, requirements, now)
assert.equal(badExpiry.isValid, false)
assert.equal(badExpiry.invalidReason, 'authorization_expired')

const tampered = JSON.parse(JSON.stringify(payload))
tampered.payload.authorization.value = '50001'
// The signature no longer covers this value. Structural checks pass; the
// signature check is the one that must catch it.
assert.equal(validateStructural(tampered, requirements, now).isValid, true)
const tamperedVerified = await verifyPayment(
  Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64'),
  requirements,
  { skipOnchain: true, now },
)
assert.equal(tamperedVerified.isValid, false)
assert.equal(tamperedVerified.invalidReason, 'invalid_signature')
console.log('PASS x402 rejection paths')

const required = buildPaymentRequired(requirements, 'X-PAYMENT header is required')
assert.equal(required.x402Version, 1)
assert.equal(required.accepts.length, 1)
assert.equal(required.error, 'X-PAYMENT header is required')

const responseHeader = encodePaymentResponse({ success: true, network: NETWORK, transaction: '0x' + '00'.repeat(32) })
assert.equal(JSON.parse(Buffer.from(responseHeader, 'base64').toString('utf8')).success, true)

const noKey = await settlePayment(payload)
assert.equal(noKey.success, false)
assert.equal(noKey.errorReason, 'facilitator_not_configured')
console.log('PASS x402 response and facilitator guard')

console.log('PASS all x402 checks')
