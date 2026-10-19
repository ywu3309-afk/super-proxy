// 便携版截图：起 exe → 等健康 → 截「账号池」与「智能体配置」→ 关掉
// 用法：node build/shoot-portable.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const EXE = resolve('release/WorkBuddy Gateway-win32-x64/WorkBuddy Gateway.exe');
if (!existsSync(EXE)) throw new Error(`找不到 ${EXE}`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
delete env.http_proxy; delete env.https_proxy;
delete env.HTTP_PROXY; delete env.HTTPS_PROXY;

const app = spawn(EXE, [], { env, stdio: 'ignore', cwd: join(EXE, '..') });
const BASE = 'http://127.0.0.1:8787';

async function waitHealth(ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return await res.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error('health 没就绪');
}

const shots = [
  ['#accounts', 'build/shots/portable-pool.png'],
  ['#agents', 'build/shots/portable-agents.png'],
  ['#overview', 'build/shots/portable-overview.png']
];

try {
  const health = await waitHealth();
  console.log(`health: ${health.accounts} 个账号，可用 ${health.usable}`);
  for (const [hash, out] of shots) {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['build/shoot.mjs', `${BASE}/${hash}`, out, '1440x1180', '5000'], { stdio: 'inherit' });
      child.on('close', resolve);
    });
    if (code !== 0) console.error(`截图失败：${out}`);
  }
} finally {
  try { process.kill(app.pid); } catch { /* ignore */ }
}
