/**
 * Hardhat config for LockVault and PositionLock.
 *
 * Same shape as the qhood contracts project, and self-contained for the same
 * reason: Hardhat 2's compiler and test toolchain are CommonJS, so the contract
 * tooling gets its own package.json (no "type" field, thus CommonJS) instead of
 * negotiating with any parent package's module system.
 *
 * The config must stay TypeScript: Hardhat only collects .ts test files when
 * the config file itself is .ts, so a .cjs config would silently run zero
 * tests.
 *
 * `solc 0.8.24` with the optimizer at 200 runs, and no Solidity dependencies at
 * all — no OpenZeppelin, no interfaces imported from a package. A contract
 * whose entire value proposition is "read me and check" has to be readable
 * without following an import graph, and every dependency is a version the
 * reader has to trust. The four functions borrowed from OpenZeppelin's
 * SafeERC20 idea are reimplemented in twenty lines with the reasoning attached.
 */

import '@nomicfoundation/hardhat-ethers'
import '@nomicfoundation/hardhat-chai-matchers'
import 'solidity-coverage'
import type { HardhatUserConfig } from 'hardhat/config'

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  mocha: {
    timeout: 60000,
  },
  /**
   * 只给**真链 fork** 用（`scripts/v4-seed-test.ts` 在 4663 的 fork 上验 V4 那段）。
   *
   * Hardhat 不认识 Robinhood Chain（4663）的硬分叉历史，`hardhat_reset` 到它的
   * 某个历史块会直接报 "No known hardfork for execution on historical block"。
   * 这里从 0 号块起声明它一直是 Cancun（Orbit L2 是 EVM 等价的 Cancun）。
   * 本地测试链（chainId 31337）不受影响。
   */
  networks: {
    hardhat: {
      chains: {
        4663: { hardforkHistory: { london: 0, merge: 0, shanghai: 0, cancun: 0 } },
      },
    },
    robinhood: {
      url: process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com/',
      chainId: 4663,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
}

export default config
