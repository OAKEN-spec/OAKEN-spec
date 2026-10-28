/**
 * Unit tests for the narrative guard.
 *
 *   node agent/test-narrative.mjs
 *
 * No network: the model is a function. The point of these tests is not that an
 * LLM writes well; it is that a number the fact sheet does not contain never
 * reaches a stored report.
 */

import assert from 'node:assert/strict'
import {
  MAX_NARRATIVE,
  factsFor,
  numericTokens,
  cleanNarrative,
  guardNarrative,
  generateNarrative,
} from './narrative.mjs'

const curveReport = {
  kind: 'curve-report',
  chain: { id: 4663, name: 'Robinhood Chain' },
  blockNumber: 99966994,
  blockTimeIso: '2026-10-28T09:22:00.000Z',
  token: {
    address: '0x83a7b54d2bbef9a9a690e8995506ac8c66b52dc9',
    name: 'OAKEN Curve Demo',
    symbol: 'OCDEMO',
    totalSupplyHuman: '1.00B',
    decimals: 18,
    codeBytes: 4591,
    owner: null,
    paused: null,
    proxy: null,
  },
  curve: {
    address: '0x5eda1a2d4ac30b173729684fb96edbcbcab0730d',
    statusLabel: 'On the curve',
    launchSupplyHuman: '1.00B',
    reservedTokensHuman: '285.71M',
    sellableTotalHuman: '714.29M',
    soldHuman: '58,925.1',
    soldPctFormatted: '0.01%',
    trackedQuoteHuman: '0.0001',
    raisePctFormatted: '0.00%',
    graduationThresholdHuman: '4.2',
    remainingToGraduateHuman: '4.1999',
    fees: { feeFormatted: '1.00%', creatorTaxFormatted: '0.00%' },
    price: { spotFormatted: '1.68020e-9', spotFdvFormatted: '1.6802' },
    estimates: { spotPriceUsdFormatted: '$0.000003990', spotFdvUsdFormatted: '$3.99', basis: 'ETH/USD $2,374.44 at 2026-10-28T08:27:07.000Z' },
  },
  locks: { total: 0, active: 0, totalRemainingHuman: null, remainingPctFormatted: null, nextUnlockIso: null },
  checks: [{ key: 'locks', label: 'OAKEN locks', status: 'flag' }],
  source: { status: 'none' },
}

const facts = factsFor(curveReport)
assert.ok(facts.includes('OCDEMO'))
assert.ok(facts.includes('58,925.1'))
assert.ok(facts.includes('4.2'))
console.log('PASS fact sheet', facts.split('\n').length, 'lines')

assert.deepEqual(numericTokens('58,925.10 and 58925.1 and 1.68020e-9 and 0.01%'), ['58925.1', '58925.1', '1.6802e-9', '0.01'])
assert.deepEqual(numericTokens('address 0x83a7b54d2bbef9a9a690e8995506ac8c66b52dc9'), [])
console.log('PASS numeric tokens')

assert.equal(cleanNarrative('  ### Hello\n\n- one   two  '), 'Hello one two')
console.log('PASS clean narrative')

const good = guardNarrative(
  'OCDEMO is on the curve at block 99966994. It sold 58,925.1 of 714.29M sellable tokens (0.01%) and raised 0.0001 ETH of the 4.2 ETH graduation line. No OAKEN lock was found. Read this as a reading, not an audit.',
  curveReport,
  'test-model',
  new Date('2026-10-28T10:00:00Z'),
)
assert.ok(good, 'a narrative that reuses the facts should pass')
assert.equal(good.factsChecked, true)
assert.equal(good.model, 'test-model')
console.log('PASS guarded narrative')

const invented = guardNarrative('OCDEMO sold 12345 tokens and is safe.', curveReport)
assert.equal(invented, null, 'a number not in the fact sheet must be rejected')
console.log('PASS invented number rejected')

const advice = guardNarrative('OCDEMO is a guaranteed return; you should buy it now.', curveReport)
assert.equal(advice, null, 'advice must be rejected')
console.log('PASS advice rejected')

const noFlags = guardNarrative('The report raised no flags and no flagged checks.', curveReport)
assert.equal(noFlags, null, 'contradicting a flag must be rejected')
console.log('PASS flag contradiction rejected')

const long = guardNarrative('x'.repeat(MAX_NARRATIVE + 1), curveReport)
assert.equal(long, null)
console.log('PASS length rejected')

const fromModel = await generateNarrative(curveReport, {
  runModel: async () => 'The curve at block 99966994 is on the curve: 58,925.1 sold, 0.0001 ETH raised against a 4.2 ETH line.',
  model: 'fake',
})
assert.ok(fromModel)
assert.equal(fromModel.model, 'fake')
console.log('PASS generate from model')

const failing = await generateNarrative(curveReport, { runModel: async () => { throw new Error('model down') } })
assert.equal(failing, null)
console.log('PASS model failure stays quiet')

console.log('PASS all narrative checks')
