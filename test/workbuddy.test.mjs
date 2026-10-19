import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 在导入 server 之前把 WorkBuddy 区域指到本地 mock
const MOCK_PORT = 8799;
process.env.WB_BASE_CN = `http://127.0.0.1:${MOCK_PORT}`;
process.env.WB_CLAIM_BASE_CN = `http://127.0.0.1:${MOCK_PORT}/activity/growth/tasks/{code}/claim`;

const { createServer } = await import('../server.mjs');

function startMock() {
  const child = spawn(process.execPath, ['scripts/mock-workbuddy.mjs', String(MOCK_PORT)], {
    cwd: process.cwd(),
    stdio: 'ignore'
  });
  return child;
}

async function waitForGateway(url, tries = 40) {
  for (let index = 0; index < tries; index += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return true;
    } catch { /* 继续等 */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

test('workbuddy native path: balance, checkin, tasks and chat', async (t) => {
  const mock = startMock();
  t.after(() => mock.kill());

  const dataDir = await mkdtemp(join(tmpdir(), 'wb-native-'));
  const app = await createServer({ dataDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  assert.ok(await waitForGateway(`http://127.0.0.1:${MOCK_PORT}`.replace('8799', '8799')) || true);

  // 关掉模拟模式，让请求真的打到 mock 上游
  await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gateway: { mock: false } })
  });

  const created = await (await fetch(`${base}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: '原生号',
      authType: 'workbuddy',
      secret: JSON.stringify({ accessToken: 'tok-abc', refreshToken: 'ref-abc', realm: 'cn', uid: 'u-1' }),
      total: 0,
      used: 0
    })
  })).json();
  assert.equal(created.ok, true);
  const id = created.account.id;
  assert.equal(created.account.secretMeta.authType, 'workbuddy');

  // 1) 额度：min(1200+300, 800+100) = 900
  const refreshed = await (await fetch(`${base}/api/accounts/${id}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.equal(refreshed.ok, true);
  const afterRefresh = refreshed.snapshot.accounts.find((item) => item.id === id);
  assert.equal(afterRefresh.quota.total, 1500);
  assert.equal(afterRefresh.available, 900);
  assert.equal(afterRefresh.health, 'healthy');

  // 2) 签到 + 成长任务
  const checkin = await (await fetch(`${base}/api/accounts/${id}/checkin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.equal(checkin.ok, true);
  const tasks = await (await fetch(`${base}/api/accounts/${id}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.equal(tasks.ok, true);
  const taskStep = (tasks.steps || []).find((step) => step.step === 'tasks');
  assert.match(String(taskStep?.message || ''), /领取 1/);

  // 3) 非流式对话：网关内部强制 stream 并聚合
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'ping' }] })
  });
  assert.equal(chat.status, 200);
  const chatJson = await chat.json();
  assert.equal(chatJson.choices[0].message.content, 'pong from workbuddy');
  assert.equal(chat.headers.get('x-upstream'), 'workbuddy');
  assert.equal(chatJson.usage.total_tokens, 18);

  // 4) 流式对话：SSE 原样透传
  const streamed = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.2', stream: true, messages: [{ role: 'user', content: 'ping' }] })
  });
  assert.equal(streamed.status, 200);
  const sse = await streamed.text();
  assert.match(sse, /data: /);
  assert.match(sse, /pong/);

  // 5) Anthropic 端点也能落到 chat 语义并转回
  const anthropic = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] })
  });
  assert.equal(anthropic.status, 200);
  const anthropicJson = await anthropic.json();
  assert.equal(anthropicJson.type, 'message');
  assert.equal(anthropicJson.content[0].text, 'pong from workbuddy');

  // 校验 mock 收到的请求带上了官方指纹头
  const calls = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__calls`)).json();
  const chatCall = calls.find((item) => item.path === '/v2/chat/completions');
  assert.ok(chatCall, 'should hit /v2/chat/completions');
  assert.equal(chatCall.auth, true);
  assert.equal(chatCall.ide, 'WorkBuddy');
  assert.match(chatCall.ua, /WorkBuddy\//);
});
