# Third-party notices

This repository redistributes the following third-party components. They keep
their own licenses; nothing here relicenses them.

## Frontend bundles (`frontend/app/vendor/`)

| Component | Version | License | Upstream |
|---|---|---|---|
| ethers | 6.x (UMD) | MIT | https://github.com/ethers-io/ethers.js |
| @walletconnect/ethereum-provider | 2.26.0 | Apache-2.0 | https://github.com/WalletConnect/walletconnect-monorepo |
| qr-creator | bundled with the above | MIT | https://github.com/nimiq/qr-creator |
| @solana/web3.js | 1.x (IIFE) | Apache-2.0 | https://github.com/solana-labs/solana-web3.js |
| buffer (polyfill) | 6.x (IIFE) | MIT | https://github.com/feross/buffer |

The bundles are minified; their upstream license texts are available at the
links above. The Apache-2.0 license text is in the root `LICENSE` file.

## Fonts (`frontend/app/fonts/`)

| Font | License | Upstream |
|---|---|---|
| Manrope | SIL Open Font License 1.1 | https://github.com/sharanda/manrope |
| JetBrains Mono | SIL Open Font License 1.1 | https://github.com/JetBrains/JetBrainsMono |

Subsets are served under the CSS family names "Oaken Display", "Oaken Text" and
"Oaken Mono". The SIL OFL permits subsetting and renaming; the font names are not
claimed as trademarks of OAKEN. Full OFL 1.1 text: https://openfontlicense.org/

## Test and build dependencies

- `contracts/lib/forge-std` — MIT OR Apache-2.0; the license files shipped with
  the vendored copy are included under `contracts/lib/forge-std/`.
- Hardhat, ethers (development), chai, mocha and TypeScript — MIT; used only to
  build and test, not redistributed.
- Solana client dependencies listed in `solana/package.json` (Apache-2.0 / MIT /
  ISC as declared by each package) — used by scripts and tests; the Rust program
  itself has no Solidity or JavaScript runtime dependency.

## Third-party protocols and names

Pons, Genius, Flap, Clanker, four.meme, pump.fun, Jupiter, Metaplex, Sourcify,
Blockscout, WalletConnect, MetaMask, OKX, Trust Wallet, Rabby and Uniswap are
third-party products. Names and addresses appear for interoperability only; no
affiliation or endorsement is claimed, and their contracts and interfaces remain
their owners' property.

If you believe a notice is missing or incorrect, open an issue — we will fix the
file rather than argue about it.
