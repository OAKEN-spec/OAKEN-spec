/**
 * ethers, resolved from the npm dependency declared in `agent/package.json`.
 *
 * The production tree imports the copy vendored under `contracts/node_modules`
 * so the Worker bundles without a separate install; the exported tree uses the
 * normal package resolution instead. The report service only needs the ESM API.
 */
export { ethers } from 'ethers'
