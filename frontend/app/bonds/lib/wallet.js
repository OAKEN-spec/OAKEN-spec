// 钱包那一层 —— 纯 EIP-1193，不引任何库。
//
// ⚠️ **`eth_estimateGas` 在这条链上不可靠**（实测会给明显偏小的值，交易 out of gas
// **静默 revert**）。所以本文件里所有写操作都**强制带 `gasLimit`**，
// 而且**不提供"让钱包自己估"这条路** —— 少一个分支就少一次静默失败。
//
// ⚠️ 另外:ethers 的 BrowserProvider 会自己先估一次再把它交给钱包，
// 所以我们**不用**它 —— 直接 `request({method:'eth_sendTransaction', params:[{gas}]})`。
// 这正是 bond/DESIGN.md §7 第 2 条说的那件事的落地。

const GAS_LIMIT = '0x2DC6C0' // 3,000,000 —— 和部署脚本同一个数，够所有申赎调用

export const hasWallet = () => typeof window !== 'undefined' && !!window.ethereum

export async function connect() {
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
  return accounts || []
}

export async function accounts() {
  return (await window.ethereum.request({ method: 'eth_accounts' })) || []
}

export async function chainId() {
  return Number(await window.ethereum.request({ method: 'eth_chainId' }))
}

/**
 * 切到目标链。没加过就先加（4902 = 链未知）。
 * `chain` 的形状和 `wallet_addEthereumChain` 要的一致。
 */
export async function switchChain(chain, id) {
  const hex = '0x' + id.toString(16)
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  } catch (e) {
    if (e && (e.code === 4902 || /Unrecognized chain/i.test(e.message || ''))) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hex,
          chainName: chain.name,
          nativeCurrency: chain.native,
          rpcUrls: [chain.rpc],
          blockExplorerUrls: chain.explorer ? [chain.explorer] : [],
        }],
      })
      return
    }
    throw e
  }
}

/** 只读调用。 */
export async function blockNumber() {
  return Number(await window.ethereum.request({ method: 'eth_blockNumber' }))
}

/** Read event logs from the wallet's RPC. Callers must keep the range small. */
export async function getLogs(address, fromBlock, topics = []) {
  return window.ethereum.request({
    method: 'eth_getLogs',
    params: [{ address, fromBlock: '0x' + Number(fromBlock).toString(16), toBlock: 'latest', topics }],
  }) || []
}

export async function call(to, data) {
  return window.ethereum.request({ method: 'eth_call', params: [{ to, data }, 'latest'] })
}

/** 写调用。**gasLimit 是强制参数，没有默认值** —— 见文件头。 */
export async function send(from, to, data) {
  return window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data, gasLimit: GAS_LIMIT }],
  })
}

/** 等回执。这笔链很闲（每块中位 8 笔），通常几秒。 */
export async function waitForReceipt(hash, { tries = 150, everyMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [hash] })
    if (r) {
      if (r.status === '0x0') throw new Error('Transaction landed but reverted: ' + hash)
      return r
    }
    await new Promise((res) => setTimeout(res, everyMs))
  }
  throw new Error('Timed out waiting for the receipt: ' + hash)
}

/** 错误信息里带 revert 原因的话，尽量把可读的那部分挑出来。 */
export function readableError(e) {
  if (!e) return 'Unknown error'
  const m = String(e.message || e)
  if (e.code === 4001 || /user rejected|User denied/i.test(m)) return 'You cancelled in your wallet'
  if (/InsufficientReserves|insufficient reserves/i.test(m)) return 'The vault does not hold enough USDG reserves for this redemption.'
  if (/CapExceeded/i.test(m)) return 'The mint cap for this bond has been reached.'
  if (/Paused/i.test(m)) return 'Mint and redeem are paused for this bond.'
  if (/NotQueued|TooEarly|Not ready/i.test(m)) return 'Timelock: this change is not queued or the delay has not passed.'
  if (/NotProposer|NotCanceller/i.test(m)) return 'Only the Safe can queue or cancel this change.'
  if (/Stale/i.test(m)) return 'The NAV price is stale. Mint and redeem wait for the next NAV update.'
  if (/NotAdmin/i.test(m)) return 'This account is not the admin.'
  return m.length > 200 ? m.slice(0, 200) + '…' : m
}
