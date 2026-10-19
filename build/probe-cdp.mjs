// 验证 CDP 抓登录态：起一个本地页面，把假会话写进 localStorage，再用 src/cdp.mjs 抓出来
// 用法：node build/probe-cdp.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grabCredential, listTargets, scan } from '../src/cdp.mjs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>WorkBuddy</title></head><body>
<h1>fake client</h1>
<script>
  localStorage.setItem('workbuddy.auth', JSON.stringify({
    account: { uid: 'uid-9527', enterpriseId: 'ent-1', departmentFullName: '研发部' },
    auth: { accessToken: 'tok-abcdefghijklmnop', refreshToken: 'ref-abcdefghijklmnop', domain: 'copilot.tencent.com', expiresAt: 1893456000000 }
  }));
  sessionStorage.setItem('noise', 'not-a-credential');
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = await mkdtemp(join(tmpdir(), 'cdp-probe-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-proxy-server',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  pageUrl
], { stdio: 'ignore' });

const cleanup = async () => {
  try { chrome.kill(); } catch { /* ignore */ }
  server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
};

try {
  let targets = [];
  for (let index = 0; index < 40; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    targets = await listTargets(PORT, { timeoutMs: 800 }).catch(() => []);
    if (targets.some((item) => item.type === 'page')) break;
  }
  if (!targets.length) throw new Error('chrome 没起来或调试端口未开');
  console.log('[1] /json/list →', targets.map((item) => `${item.type}:${item.title}`).join(', '));

  const scanned = await scan({ ports: [PORT, 9999], timeoutMs: 1000 });
  console.log('[2] scan →', JSON.stringify(scanned, null, 1));

  const grabbed = await grabCredential({ port: PORT, waitMs: 3000 });
  console.log('[3] grab →', JSON.stringify(grabbed, null, 1));
  if (!grabbed.ok) throw new Error(`抓取失败：${grabbed.reason}`);
  const cred = grabbed.credential;
  if (cred.uid !== 'uid-9527' || cred.accessToken !== 'tok-abcdefghijklmnop' || cred.refreshToken !== 'ref-abcdefghijklmnop') {
    throw new Error(`字段不对：${JSON.stringify(cred)}`);
  }
  if (cred.department !== '研发部') throw new Error('部门字段没抓到');
  console.log('[4] 断言通过：uid / accessToken / refreshToken / enterpriseId / department 全部命中');

  // 用真实解析器过一遍，确认能转成网关凭据
  const { parseCredential } = await import('../src/workbuddy.mjs');
  const parsed = parseCredential(JSON.stringify(cred));
  console.log('[5] parseCredential →', JSON.stringify(parsed));
  if (!parsed?.token || !parsed?.uid) throw new Error('parseCredential 不认');
  if (parsed.department !== '研发部') throw new Error('department 丢了');
  console.log('OK');
} finally {
  await cleanup();
}
