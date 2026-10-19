import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCredentialFromRows, grabCredential, listTargets, scan } from '../src/cdp.mjs';
import { parseCredential } from '../src/workbuddy.mjs';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const chromePath = CHROME_CANDIDATES.find((item) => existsSync(item));

// 纯函数：存储条目 → 凭据（不依赖浏览器）
test('extractCredentialFromRows picks the entry with refreshToken', () => {
  const rows = [
    ['local', 'noise', 'hello'],
    ['local', 'auth', JSON.stringify({ account: { uid: 'u-1' }, auth: { accessToken: 'a'.repeat(20) } })],
    ['local', 'session', JSON.stringify({ accessToken: 'tok-main-123456', refreshToken: 'ref-main-123456', uid: 'u-2', enterpriseId: 'e-2' })],
    ['session', 'jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJ1LTMifQ.signature']
  ];
  const picked = extractCredentialFromRows(rows);
  assert.equal(picked.accessToken, 'tok-main-123456');
  assert.equal(picked.refreshToken, 'ref-main-123456');
  assert.equal(picked.uid, 'u-2');
  assert.equal(picked.enterpriseId, 'e-2');
  assert.equal(extractCredentialFromRows([['local', 'x', 'nothing']]), null);
});

test('cdp: scan and grab credential from a live client page', async (t) => {
  if (!chromePath) {
    t.skip('本机没有 Chrome/Edge，跳过真实 CDP 用例');
    return;
  }
  const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>WorkBuddy</title></head><body>
<script>
  localStorage.setItem('workbuddy.auth', JSON.stringify({
    account: { uid: 'uid-9527', enterpriseId: 'ent-1', departmentFullName: '研发部' },
    auth: { accessToken: 'tok-abcdefghijklmnop', refreshToken: 'ref-abcdefghijklmnop', domain: 'copilot.tencent.com', expiresAt: 1893456000000 }
  }));
</script></body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  const profile = await mkdtemp(join(tmpdir(), 'cdp-test-'));
  const port = 9400 + Math.floor(Math.random() * 300);
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-proxy-server', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, pageUrl
  ], { stdio: 'ignore' });

  t.after(async () => {
    try { chrome.kill(); } catch { /* ignore */ }
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  });

  let targets = [];
  for (let index = 0; index < 40; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    targets = await listTargets(port, { timeoutMs: 800 }).catch(() => []);
    if (targets.some((item) => item.type === 'page' && /workbuddy/i.test(`${item.title || ''} ${item.url || ''}`))) break;
  }
  assert.ok(targets.length, '调试端口应能列出目标');

  const scanned = await scan({ ports: [port, port + 1], timeoutMs: 1000 });
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].port, port);
  assert.equal(scanned[0].client, 'workbuddy');

  const grabbed = await grabCredential({ port, waitMs: 2000 });
  assert.equal(grabbed.ok, true);
  assert.equal(grabbed.source, 'storage');
  assert.equal(grabbed.credential.uid, 'uid-9527');
  assert.equal(grabbed.credential.refreshToken, 'ref-abcdefghijklmnop');

  const parsed = parseCredential(JSON.stringify(grabbed.credential));
  assert.equal(parsed.token, 'tok-abcdefghijklmnop');
  assert.equal(parsed.department, '研发部');
  assert.equal(parsed.realm, 'cn');
});
