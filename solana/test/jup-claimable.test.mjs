// Jupiter escrow 的可领数量：到期那一刻最容易炸的是 **BigInt 与 number 混算**。
// 这个测试故意在 cliff 之后调用，钉住 `Math.min(BigInt, number)` 那类错误。
import assert from 'node:assert/strict';
import { jupClaimable } from '../../frontend/app/solana.js';

const base = {
  cliffTime: 1_000, frequency: 1, cliffUnlockAmount: 999n,
  amountPerPeriod: 1n, numberOfPeriod: 1n, totalClaimedAmount: 0n, cancelledAt: 0,
};
assert.equal(jupClaimable(base, 999), 0n, 'cliff 之前不能领');
assert.equal(jupClaimable(base, 1_000), 999n, 'cliff 当下释放 cliff 部分');
assert.equal(jupClaimable(base, 1_001), 1_000n, '一个周期后全部释放');
assert.equal(jupClaimable({ ...base, totalClaimedAmount: 400n }, 1_001), 600n, '已领部分要扣掉');
assert.equal(jupClaimable({ ...base, cancelledAt: 1_002 }, 2_000), 0n, '取消后不能再领');
assert.equal(jupClaimable({ ...base, numberOfPeriod: 5n, amountPerPeriod: 10n, cliffUnlockAmount: 0n }, 10_000), 50n, '周期上限不能被越过');
console.log('✓ jupClaimable: cliff/周期/已领/取消/上限 全部对上');
