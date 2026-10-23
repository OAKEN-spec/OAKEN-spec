/**
 * Coverage-only Hardhat config.
 *
 * solidity-coverage instruments every statement, which pushes LockVault's
 * createLock past the legacy codegen stack limit. viaIR fixes the compilation
 * but changes the bytecode, so this config is kept separate from
 * hardhat.config.ts (which production deployments and the deterministic
 * address checks use).
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
      viaIR: true,
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache-coverage',
    artifacts: './artifacts-coverage',
  },
  mocha: {
    timeout: 120000,
    // viaIR changes the bytecode, so the determinism tests cannot pass here;
    // they still run in the normal suite.
    grep: '^(?!.*deterministic deployment).*$',
  },
}

export default config
