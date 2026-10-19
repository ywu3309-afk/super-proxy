// 便携版自检：启动 exe → 探活 → 逐项打接口 → 收工关掉
// 用法：node build/probe-portable.mjs [--keep]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const EXE = resolve('release/WorkBuddy Gateway-win32-x64/WorkBuddy Gateway.exe');
if (!existsSync(EXE)) throw new Error(`找不到 ${EXE}`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(EXE, [], { env, stdio: 'ignore', detached: false, cwd: join(EXE, '..') });
const BASE = 'http://127.0.0.1:8787';

async function get(path, options) {
  const res = await fetch(`${BASE}${path}`, { ...options, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function waitHealth(ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return await res.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error('health 没就绪');
}

const keep = process.argv.includes('--keep');
try {
  const health = await waitHealth();
  console.log('[1] /health →', JSON.stringify(health));

  const accounts = await get('/api/state');
  const list = accounts.body.accounts || [];
  const pool = accounts.body.pool || accounts.body.totals || {};
  console.log(`[2] /api/state → ${accounts.status}，${list.length} 个账号 · 池 ${JSON.stringify(pool)}`);
  for (const item of list.slice(0, 8)) {
    console.log(`    ${item.label || item.id} · ${item.status} · 可用 ${item.usable ?? item.remaining ?? '-'}`);
  }

  const atrest = await get('/api/atrest');
  console.log('[3] /api/atrest →', JSON.stringify(atrest.body));

  const agents = await get('/api/agents');
  const det = Object.entries(agents.body.clients || {}).map(([id, item]) => `${id}:${item.detected ? (item.applied ? '已配置' : '已安装') : '未装'}`).join('  ');
  console.log(`[4] /api/agents → ${agents.status}  ${det}`);

  const scan = await get('/api/desktop/scan');
  const items = (scan.body.items || []).map((item) => `${item.realm}:${item.ok ? 'ok' : item.reason}${item.keyRequired ? '(需密钥)' : ''}`);
  console.log(`[5] /api/desktop/scan → ${scan.status}  ${items.join(' ') || '无凭据文件'}`);

  const models = await get('/v1/models');
  const ids = (models.body.data || []).map((m) => m.id);
  console.log(`[6] /v1/models → ${models.status}  ${ids.join(', ')}`);

  const chat = await get('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'workbuddy-gateway-v1', messages: [{ role: 'user', content: 'ping' }] })
  });
  const accountId = chat.body?.id || '(无 id)';
  console.log(`[7] chat → ${chat.status}  ${accountId}`);
} finally {
  if (!keep) {
    try { process.kill(child.pid); } catch { /* ignore */ }
  } else {
    console.log(`[keep] 进程留在后台：pid ${child.pid}`);
  }
}
