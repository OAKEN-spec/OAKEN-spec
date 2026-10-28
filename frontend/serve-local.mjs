#!/usr/bin/env node
/**
 * Minimal static server for the exported frontend.
 *
 *   node serve-local.mjs [port]        # default 8080
 *
 * URL → file mapping is the same one the production build uses. What is NOT in
 * this repository is the indexer/API (`/api/*`): list pages will show their
 * read-failure or empty states, while record pages still read the chain
 * directly from your browser through the public RPCs in `app/oaken.js`.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8080);

const STATIC = new Map([
  ['/', 'app/index.html'],
  ['/locks', 'app/locks.html'],
  ['/locks/create', 'app/create.html'],
  ['/launch', 'app/launch.html'],
  ['/launches', 'app/launches.html'],
  ['/names', 'app/names.html'],
  ['/launch/solana', 'app/launch-solana.html'],
  ['/locks/solana', 'app/locks-solana.html'],
  ['/agents', 'app/agents.html'],
  ['/agents.md', 'app/agents.md'],
  ['/me', 'app/me.html'],
  ['/activity', 'app/activity.html'],
  ['/dashboard', 'app/dashboard.html'],
  ['/leaderboard', 'app/leaderboard.html'],
  ['/launchpads', 'app/launchpads.html'],
  ['/docs', 'app/docs.html'],
  ['/about', 'app/about.html'],
  ['/faq', 'app/faq.html'],
  ['/verify', 'app/verify.html'],
  ['/security', 'app/security.html'],
  ['/security/bug-bounty', 'app/bug-bounty.html'],
  ['/terms', 'app/terms.html'],
  ['/privacy', 'app/privacy.html'],
  ['/tools', 'app/tools.html'],
  ['/tools/multisender', 'app/tools-multisender.html'],
  ['/tools/token', 'app/tools-token.html'],
  ['/tools/airdrop', 'app/tools-airdrop.html'],
  ['/tools/presale', 'app/tools-presale.html'],
  ['/bonds', 'app/bonds/index.html'],
]);

const DYNAMIC = [
  [/^\/curve\/[^/]+\/0x[0-9a-fA-F]{40}$/, 'app/curve.html'],
  [/^\/curve\/solana\/[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'app/curve-solana.html'],
  [/^\/locks\/[^/]+\/record\/[^/]+$/, 'app/record.html'],
  [/^\/locks\/[^/]+\/position(?:\/[^/]+)?$/, 'app/position.html'],
  [/^\/locks\/[^/]+\/0x[0-9a-fA-F]{40}$/, 'app/token.html'],
  [/^\/launchpads\/[^/]+\/0x[0-9a-fA-F]{40}$/, 'app/launchpad-pool.html'],
  [/^\/tools\/airdrop\/[^/]+\/\d+$/, 'app/tools-airdrop-campaign.html'],
  [/^\/tools\/presale\/[^/]+\/0x[0-9a-fA-F]{40}$/, 'app/tools-presale-sale.html'],
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function resolveFile(rawPath) {
  let clean;
  try { clean = decodeURIComponent(rawPath.split('?')[0]); } catch { return null; }
  clean = clean.replace(/\/+$/, '') || '/';
  if (STATIC.has(clean)) return STATIC.get(clean);
  for (const [re, file] of DYNAMIC) if (re.test(clean)) return file;
  /* 唯一提供的 API：链注册表的静态快照（由导出脚本从 src/chains.mjs 生成）。
     没有它，记录页连"读哪条链"都解析不出来。其余 /api/* 不提供。 */
  if (clean === '/api/chains') return 'api/chains.json';
  if (clean.startsWith('/app/')) return clean.slice(1);
  if (clean.startsWith('/oaken/')) return 'brand/oaken/' + clean.slice('/oaken/'.length);
  if (clean.startsWith('/bonds/')) return 'app' + clean;      // /bonds/app.css → app/bonds/app.css
  if (/^\/(favicon\.png|logo192\.png|logo512\.png|apple-touch-icon\.png)$/.test(clean)) return 'brand/' + clean.slice(1);
  return null;
}

const notFound = async (res) => {
  const body = await readFile(path.join(ROOT, 'app/404.html')).catch(() => 'Not found');
  res.writeHead(404, { 'content-type': TYPES['.html'] });
  res.end(body);
};

createServer(async (req, res) => {
  const file = resolveFile(req.url || '/');
  if (!file) return notFound(res);
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) return notFound(res);           // 不许 ../ 跳出目录
  try {
    const body = await readFile(full);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    return notFound(res);
  }
}).listen(PORT, () => {
  console.log(`OAKEN frontend (static, no indexer) → http://localhost:${PORT}`);
  console.log('List pages will show read-failure/empty states; record pages read the chain directly.');
});
