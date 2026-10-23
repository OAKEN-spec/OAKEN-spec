// ⚠️ **生成物，不要手改。** 由 bond/scripts/gen-app.ts 从**编译产物 + deployments.json** 生成。
// 手抄十六进制是不行的:抄错一个字节，报错是"交易 revert"，看起来像合约写错了。
// 合约改了、或者重新部署了 → 在 bond/ 下重跑 `npx hardhat run scripts/gen-app.ts`。

export const CHAIN_ID = 4663;
export const CHAIN = {
  "name": "Robinhood Chain",
  "rpc": "https://rpc.mainnet.chain.robinhood.com",
  "explorer": "https://robinhoodchain.blockscout.com",
  "native": {
    "name": "Ether",
    "symbol": "ETH",
    "decimals": 18
  }
};
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
/** 激励币（质押奖励的 1 号流）。真链上是那个代理合约，18 位。 */
export const REWARD = "0xbe98D7c8EBB304F6bb7aef2ef04589ED56C8830a";
/** 批量合约（五个质押池的地址**写死在它里面**）。没部署过就是 null ——
 *  页面据此决定"一键全领 / 跨池总览"这两个块要不要显示，而不是去调一个 0 地址。 */
export const BATCHER = null;
export const DEPLOYED_AT = "2026-10-17T07:02:00.727Z";
/** ── v1.2（2026-10-14）:分流 / 折扣 / 治理 ────────────────────────────────
 *  ⚠️ 没有 v12 段时**整组为 null** —— 页面据此隐藏治理面板与折扣提示，
 *     而不是去调一个 0 地址（症状会是"点了没反应"）。 */
export const V12 = null;
/** 质押池的发放周期（秒）。页面用它把"每秒速率"换算成年化 —— 不写死。 */
export const STAKING_DURATION = 2592000;

/** 小数位。⚠️ 三套不一样 —— 差一个 10¹²，见 bond/DESIGN.md §3.1。 */
export const DECIMALS = { usdg: 6, bond: 18, feed: 8, reward: 18 };

export const BONDS = [
  {
    "symbol": "OAKEN",
    "name": "OAKEN Bond",
    "token": "0x948344c5ee2748d7E3FD1c49f472C1e88232e786",
    "vault": "0x1C14c153E55E260970DDbd2B51C938d570fa9839",
    "oracle": "0x9BC910D817b96174704C340fF791E7eC53b82596",
    "staking": "0xd14a16f5CCb4D1cbEA3C646A875EC61a4DD5FE36"
  }
];

/** 函数选择器 —— 在这里算，页面只负责把它们拼成字节。
 *  ⚠️ 整段用 JSON.stringify 出来（**键带引号**），别写成 JS 对象字面量:
 *     消费它的东西里有一个是**用 JSON.parse 读的**（tools/app-e2e.js），
 *     而裸键的对象字面量不是合法 JSON —— 报错是 "Expected property name"，
 *     看起来像生成器坏了，其实是格式选错了。
 *  ⚠️ 这段注释本身在**模板字符串**里 —— 里面不许出现反引号，
 *     出现一个就把模板提前闭合，而报错是 TS1005 "',' expected"，指不到这里。 */
export const SEL = {
  "bond": {
    "allowance": "0xdd62ed3e",
    "approve": "0x095ea7b3",
    "balanceOf": "0x70a08231",
    "decimals": "0x313ce567",
    "totalSupply": "0x18160ddd"
  },
  "vault": {
    "bondOutFor": "0xbc6c4b45",
    "isSolvent": "0x5ce23950",
    "maxRedeemable": "0x64e1274e",
    "mint": "0xa0712d68",
    "mintCap": "0x76c71ca1",
    "paused": "0x5c975abb",
    "price": "0xa035b1fe",
    "redeem": "0xdb006a75",
    "redeemFeeBps": "0x09f6442c",
    "reserves": "0x75172a8b",
    "setParams": "0xebdec6d3",
    "usdgOutFor": "0x32e823fe"
  },
  "oracle": {
    "decimals": "0x313ce567",
    "latestRoundData": "0xfeaf968c",
    "peekUnsafe": "0x79358490"
  },
  "erc20": {
    "allowance": "0xdd62ed3e",
    "approve": "0x095ea7b3",
    "balanceOf": "0x70a08231",
    "decimals": "0x313ce567"
  },
  "staking": {
    "accountedOf": "0x71b2dc7d",
    "rewardToken": "0x027110da",
    "bankedOf": "0x1dad324b",
    "bond": "0x64c9ec6f",
    "claimFor": "0xddeae033",
    "earned": "0xe39c08fc",
    "exit": "0xe9fad8ee",
    "getReward": "0x3d18b912",
    "held": "0xdedd8ed8",
    "notifyReward": "0xe81a5884",
    "owed": "0xb1276604",
    "rewardDuration": "0xf520e7e5",
    "snapshot": "0x26512160",
    "stake": "0xa694fc3a",
    "stakedOf": "0xaf500ba3",
    "streamOf": "0x2527b6fd",
    "streamRemaining": "0xf664e065",
    "sync": "0xfff6cae9",
    "totalStaked": "0x817b1cd2",
    "usdg": "0xf5b91b7b",
    "withdraw": "0x2e1a7d4d"
  },
  "batcher": {
    "claimAll": "0xd1058e59",
    "overview": "0xaf2d2aa4",
    "pools": "0xc5c51dca",
    "syncAll": "0xa11e6464"
  },
  "reward": {
    "allowance": "0xdd62ed3e",
    "approve": "0x095ea7b3",
    "balanceOf": "0x70a08231",
    "decimals": "0x313ce567",
    "symbol": "0x95d89b41",
    "totalSupply": "0x18160ddd"
  },
  "router": {
    "fundRebate": "0x2ade3a07",
    "pairAt": "0x9af5aabc",
    "pairCount": "0x173fd1db",
    "rebateFor": "0x2c3076ae",
    "rebatePot": "0xaef1d436",
    "redeem": "0x7cbc2373"
  },
  "xOak": {
    "allowance": "0xdd62ed3e",
    "approve": "0x095ea7b3",
    "balanceOf": "0x70a08231",
    "deposit": "0xb6b55f25",
    "getPastVotes": "0x3a46b1a8",
    "totalSupply": "0x18160ddd",
    "withdraw": "0x2e1a7d4d"
  },
  "poll": {
    "enqueue": "0x1ffc735d",
    "execute": "0xfe0d94c1",
    "proposalAt": "0x5bb838cb",
    "proposalCount": "0xda35c664",
    "proposalThreshold": "0xb58131b0",
    "propose": "0x3153fedb",
    "quorumBps": "0xcd2ddd0c",
    "state": "0x3e4f49e6",
    "vote": "0x943e8216",
    "voted": "0x5277b4ae",
    "votingPeriod": "0x02a251a3",
    "weightOf": "0x8935ced5"
  },
  "timelock": {
    "delay": "0x6a42b8f8",
    "etaOf": "0x5654c570",
    "isCanceller": "0xb426475e",
    "isProposer": "0x74ec29a0"
  },
  "splitter": {
    "pool": "0x16f0115b",
    "split": "0xf7654176",
    "stakerBps": "0xb53b2707",
    "treasury": "0x61d027b3"
  }
};

/** 解码返回值要的形状（有序的参数类型列表）。 */
export const OUT = {
  latestRoundData: ['uint80', 'int256', 'uint256', 'uint256', 'uint80'],
  peekUnsafe: ['uint80', 'int256', 'uint256'],
  // v1.2 的多返回值（顺序照合约里的 return 写，错一格就是"数字对不上"）
  pairAt: ['address', 'address', 'address'],
  proposalAt: ['address', 'bytes', 'string', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bool'],
};
