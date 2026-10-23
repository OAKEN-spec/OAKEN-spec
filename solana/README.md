# Oaken Lock — Solana

> ## 2026-10-23：程序已部署到 Solana 主网，升级权已置空
>
> - Program ID `Co9ZnAVxX2siGThhjTpPgXPHYrCev1nrXFyGB1VcZcQW`
>   · ProgramData `34ZjBrqr37VxPHPx2VFGDgmuCKjPRayi44QjT93qhTgn`
>   · **Authority: none**（部署后 `set-upgrade-authority --final`，不可逆）
>   · 链上字节 sha256 `8de3b7cbe1041ad0f846e3a8e4e80d337e5a6f115f9aba0fbb4924bc65abdce4`，
>     与本地 `target/deploy/oaken_lock.so` 逐字节相同。
> - **E2E 25/25 全绿**：GitHub Actions `.github/workflows/solana-e2e.yml` 在 ubuntu 上编译程序、
>   起本地 `solana-test-validator`、跑五条指令（建锁/领取/拒绝/转让/放弃/撤锁/计数器）。
>   主网也跑了同一套（5 把测试锁留在链上，可读回）。
> - E2E 抓出并修掉三个只有真 CPI 才会暴露的 bug：PDA 建账户要用 `invoke_signed`；
>   claim 要带 beneficiary 账户；claim 的 lock 账户必须是可写。
> - 站点 `/locks/solana` 现在默认用自有程序；Jupiter Lock 保留为第三方选项。
> - 部署成本：programdata rent 0.24785 SOL + buffer ≈0.2476 ⇒ 峰值约 0.55 SOL。

> ## 2026-10-20：周边先上了真链（历史）
>
> - 站点新增 `/launch/solana`（OAKEN Factory = SPL + Metaplex；pump.fun = 手写 `create_v2`）和
>   `/locks/solana`（当时用第三方 **Jupiter Lock**，因为自有程序尚未部署）。
> - 真链实验（mainnet）：pump.fun 发射 `BbV7QT1u…qXmY` → 买 5U → Jupiter 锁 1 小时
>   （escrow `ymNVpHAm…q9k`）；OAKEN Factory 另发 `5MqDmgSs…Qk9u`，mint 权限已吊销。
>   证据在 `solana/_live-test-evidence.json` 与 `solana/_live-own-launch-evidence.json`。
> - 本轮修了 `lib/solana.js` 两处**从没上链所以一直没暴露**的客户端 bug：
>   时钟 sysvar 写成 `SysvarClock…`（正确是 `SysvarC1ock…`，数字 1）；建锁账户表把 ATA
>   （`source`）标成了 signer。这两处会让第一笔真链建锁直接失败。
> - 资金：legacy 4663 钱包经 Relay 桥 0.0045 ETH → 0.1033 SOL（脚本 `scripts/fund-from-relay.mjs`）。
> - 新脚本：`scripts/live-pump-lock.mjs`（发射+买+锁）、`scripts/live-own-launch.mjs`（自有发射）、
>   `scripts/claim-jup-lock.mjs`（到期领取）。
>
> **2026-10-23 更新：下面这段"没在链上跑过"已经过期。** 程序已部署、升级权已置空；
> 五条指令在本地验证器（25/25）和主网都实际执行过。保留原文只作历史记录。

> ## 历史状态（2026-10-11）：写完了，但当时没在链上跑过
>
> - ✅ **编得过**：`cargo build-sbf` → `target/deploy/oaken_lock.so`（48.6 KB）
> - ✅ **17 个单元测试过**：状态布局的往返、指令编解码、SPL/ATA/System 的指令字节、PDA 推导
> - ❌ **五条指令一次都没在链上执行过** —— 所以**不能说它能用**。真正没验的是 CPI 那几段：
>   建账户、建 ATA、`transfer_checked`、拿 PDA 种子签名把币转出来。
> - ⛔ 站点上曾经接好的两页（列表 / 创建）已经**撤到 `site-parked/`**：指向一个不存在的程序
>   就是死路（连钱包 → 失败），而这个项目对死路的态度是"宁可撤掉"。
>   `lib/solana.js`（页面与测试共用的那份布局/指令实现）也一起留在仓库里。
>
> ### 本地为什么跑不起来（三条路都试过）
>
> | 路线 | 卡在哪 |
> |---|---|
> | `solana-test-validator` | Windows 上要建符号链接 → 需要开发者模式或管理员权限，报 `1314 客户端没有所需的特权` |
> | `cargo test-sbf` | 测试依赖 `solana-program-test → agave-precompiles → openssl-sys`，Git Bash 里要从源码编 OpenSSL，缺 Perl 模块（`Locale::Maketext::Simple`） |
> | `solana-bankrun` | **没有 win32 的预编译包**（只有 darwin / linux） |
>
> ### 要把它验通，两条最便宜的路（都不用真钱）
>
> **① devnet**（推荐）：去 https://faucet.solana.com 领一点 devnet SOL 打到部署钱包（免费），然后
>
> ```bash
> export https_proxy=http://127.0.0.1:12000       # 这台机器直连 Solana RPC 不通，走系统代理
> solana config set --url devnet
> solana program deploy target/deploy/oaken_lock.so --program-id program-keypair.json
> node scripts/e2e.mjs                            # 五条指令逐个走，判据取链
> ```
>
> **② 在 Mac / Linux 上**：`node scripts/e2e.mjs --start`（自带验证器；
> 这也是 CI 跑的那条）。

EVM 那边 `LockVault` 的 Solana 版：把 SPL 代币锁进一个只有到期才动得了的金库。
**没有 owner、没有暂停、部署后升级权置空** —— 和 EVM 版的取舍是同一条。

程序地址（主网/测试网/本地都是这一个，Solana 的程序地址来自 keypair，不是 CREATE2）：

```
Co9ZnAVxX2siGThhjTpPgXPHYrCev1nrXFyGB1VcZcQW
```

> ⚠ `program-keypair.json` 是程序的**身份**。**升级权已于 2026-10-23 置空**，
> 它现在只能证明"这个地址是我们的"，不能再用来升级。妥善备份即可。

## 和 EVM 版怎么对上

| | EVM `LockVault` | 这里 |
|---|---|---|
| 币放哪 | 合约自己持有 | 锁 PDA 名下的 ATA（`vault`） |
| 领取 | 到期后**任何人**可代提交，币只进受益人 | 一样（`claim` 的 payer 谁都能当） |
| 撤锁 | 创建时声明 `revocable` 才可撤，且只在到期前 | 一样 |
| 放弃 | `renounceLockOwnership` | `Renounce` |
| 转让 | `transferLockOwnership` | `TransferOwnership` |
| 阶梯 vesting | 有（`steps`/`cycleBps`） | **没有**（这一版只做"某天一次性解锁"） |
| 可升级 | 合约不可升级 | 程序部署后**要把升级权置空**（见下） |

**v1 没有的东西在代码里也不存在** —— 不是被跳过分支。阶梯 vesting 是下一版：
加一个字段容易，但状态布局、指令、解析、页面四处都要同时改，而"部分实现"比"没有"更危险。

## 程序长什么样

```
program/src/
  lib.rs          入口 + declare_id
  state.rs        Lock 账户的字节布局（240 字节，手写，带单测）
  instruction.rs  线格式：1 个 tag + 定长字段（手写，带单测）
  spl.rs          SPL Token / ATA / System 的指令字节（手写，带单测）
  processor.rs    五条指令的实现，每条头上写着它的账户表
```

依赖只有 `solana-program` 一个 —— 不用 Anchor，不用 `spl-token` crate。
理由和 EVM 那边不用 OpenZeppelin 一样：这个产品卖的是"读我然后自己判断"，
不能让读者顺着 import 图去追信任链。`spl.rs` 里那三条指令加起来不到三十行，
每条都附了字节形状和单元测试。

## 跑起来

```bash
# 1. 单元测试（宿主机，不需要链）
cargo test

# 2. 编出可部署的 .so（SBF 工具链）
cargo build-sbf          # 产物在 target/deploy/oaken_lock.so

# 3. 本地验证器 + 端到端（建币 → 锁 → 提前领被拒 → 到期领 → 转让 → 放弃 → 撤锁）
node scripts/e2e.mjs --start
```

`scripts/e2e.mjs` 用的是**页面那份** `app/solana-build.js`（布局解析 + 指令编码），
所以它同时证明"页面和程序对协议的理解是同一份"。

## 部署

```bash
# 本地/devnet 的钱包
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/id.json
solana config set --url devnet          # 或 mainnet-beta
solana airdrop 2                        # 只有 devnet/testnet 有水管

# 部署（用程序自己的 keypair）
solana program deploy target/deploy/oaken_lock.so \
  --program-id program-keypair.json

# ⚠ **最后一件事**：把升级权置空。做了就回不去了 —— 2026-10-23 已在主网执行（Authority: none）。
solana program set-upgrade-authority Co9ZnAVxX2siGThhjTpPgXPHYrCev1nrXFyGB1VcZcQW --final
```

## 工具链（这台机器上装了什么）

```
rustup + stable 1.99          ~/.cargo/bin        （走清华镜像，直连是 20KB/s 级别）
solana CLI 4.3.0 / SBF 4.4.0  ~/.local/share/solana/install/active_release/bin
@solana/web3.js 1.99          solana/node_modules  （浏览器那份已 vendor 到
                                                    public/app/vendor/solana-web3.iife.min.js）
```

## 测试现状（2026-10-23 复核后）

- **Rust 单元测试 17 条**（`program/src/*.rs`）：状态布局往返、指令编解码、SPL/ATA/System
  指令字节、PDA 推导。`cargo test` 只编这些，**不依赖** `solana-program-test`。
- **集成判据 = CI 的 E2E**：`.github/workflows/solana-e2e.yml` 在 ubuntu 上
  `cargo build-sbf` → 起 `solana-test-validator` → `scripts/e2e.mjs` 五条指令 25 项判据。
- 仓库里**不再保留**跑不起来的路径：`program/tests/lock.rs`（账户表过期、从未在 CI 跑过）、
  `scripts/e2e-bankrun.mjs`（BanksClient 无 `getAccountInfo`，win32 也无预编译包）、
  `lib/solana.js`（旧客户端副本，无任何调用方）。页面与测试共用的是 `frontend/app/solana-build.js`。
- **程序不要求解锁日期在未来**（只有页面要求 `now + 30s`）。直接调用程序的集成方
  可以建一把“立刻可领”的锁 —— 锁账户本身不构成“未来才解锁”的证明，页面才会。
