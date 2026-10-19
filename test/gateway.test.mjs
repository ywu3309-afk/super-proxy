import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../server.mjs';
import { nextDailyRunAt, localDate } from '../src/util.mjs';
import { parseCurl } from '../src/curl.mjs';

async function boot(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'wb-gateway-'));
  const app = await createServer({ dataDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  if (options.setup) await options.setup({ app, base });
  return { app, base, dataDir };
}

async function addAccount(base, body) {
  const response = await fetch(`${base}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return response.json();
}

test('nextDailyRunAt always returns a future instant within 24 hours', () => {
  const now = new Date('2026-10-18T16:00:00Z');
  const next = nextDailyRunAt('09:30', 'America/Los_Angeles', now);
  assert.ok(next.getTime() > now.getTime());
  assert.ok(next.getTime() - now.getTime() <= 25 * 3600 * 1000);
  const tokyo = nextDailyRunAt('09:30', 'Asia/Tokyo', now);
  assert.ok(tokyo.getTime() > now.getTime());
});

test('parseCurl extracts method, path, headers and cookie', () => {
  const parsed = parseCurl(`curl 'https://example.com/api/checkin?x=1' -H 'cookie: a=b; c=d' -H 'x-csrf: t' -X POST --data-raw '{"k":1}'`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.origin, 'https://example.com');
  assert.equal(parsed.path, '/api/checkin?x=1');
  assert.equal(parsed.authType, 'cookie');
  assert.equal(parsed.secret, 'a=b; c=d');
  assert.deepEqual(parsed.body, { k: 1 });
  assert.equal(parsed.headers['x-csrf'], 't');
});

test('account CRUD keeps secrets encrypted on disk', async (t) => {
  const { base, dataDir } = await boot(t);
  const created = await addAccount(base, { label: '主号', total: 1000, used: 100, secret: 'cookie-value-should-not-leak' });
  assert.equal(created.ok, true);
  const id = created.account.id;
  assert.equal(created.account.hasSecret, true);
  assert.equal(JSON.stringify(created.account).includes('cookie-value-should-not-leak'), false);

  const rawSecrets = await readFile(join(dataDir, 'secrets.json'), 'utf8');
  assert.equal(rawSecrets.includes('cookie-value-should-not-leak'), false);

  const patched = await (await fetch(`${base}/api/accounts/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: '主号改', notes: 'n' })
  })).json();
  assert.equal(patched.account.label, '主号改');

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.accounts.length, 1);
  assert.equal(state.totals.available, 900);

  const removed = await (await fetch(`${base}/api/accounts/${id}`, { method: 'DELETE' })).json();
  assert.equal(removed.ok, true);
  assert.equal(removed.snapshot.accounts.length, 0);
});

test('gateway routes to the account with the most remaining quota', async (t) => {
  const { base } = await boot(t);
  await addAccount(base, { label: '小号', total: 500, used: 100 });
  await addAccount(base, { label: '大号', total: 4000, used: 200 });

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'workbuddy-gateway-v1', messages: [{ role: 'user', content: 'hello' }], estimatedTokens: 300 })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(response.headers.get('x-gateway-mode'), 'simulation');

  const state = await (await fetch(`${base}/api/state`)).json();
  const big = state.accounts.find((account) => account.label === '大号');
  const small = state.accounts.find((account) => account.label === '小号');
  assert.equal(body.scheduled_account_id, big.id);
  assert.equal(big.quota.used, 500);
  assert.equal(small.quota.used, 100);
});

test('gateway rejects when every quota is exhausted or account disabled', async (t) => {
  const { base } = await boot(t);
  const created = await addAccount(base, { label: '唯一', total: 100, used: 0 });
  const state1 = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state1.totals.available, 100);

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], estimatedTokens: 5000 })
  });
  assert.equal(response.status, 503);

  await fetch(`${base}/api/accounts/${created.account.id}/toggle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const second = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], estimatedTokens: 10 })
  });
  assert.equal(second.status, 503);
});

test('automation pipeline signs in, runs tasks and claims in simulation mode', async (t) => {
  const { base } = await boot(t);
  const created = await addAccount(base, { label: '自动号', total: 1000, used: 0 });
  await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ automation: { settleBeforeClaimMs: 0 } })
  });

  const run = await (await fetch(`${base}/api/automation/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.equal(run.ok, true);
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].status, 'completed');

  const state = await (await fetch(`${base}/api/state`)).json();
  const account = state.accounts.find((item) => item.id === created.account.id);
  const today = localDate(new Date(), state.settings.timezone);
  assert.equal(account.lastCheckInDate, today);
  assert.equal(account.lastClaimDate, today);
  assert.ok(['completed', 'nothing_pending'].includes(account.lastTaskStatus));
  assert.ok(account.quota.total > 1000, '签到或领取应增加总额度');
  assert.ok(state.events.some((event) => event.type === 'checkin'));
  assert.ok(state.events.some((event) => event.type === 'claim'));
});

test('single-step run records a job and keeps the account usable', async (t) => {
  const { base } = await boot(t);
  const created = await addAccount(base, { label: '单步', total: 800, used: 0 });
  const result = await (await fetch(`${base}/api/accounts/${created.account.id}/checkin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })).json();
  assert.equal(result.status, 'completed');
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.jobs.length, 1);
  assert.equal(state.accounts[0].status, 'available');
});

test('settings patch is reflected in the state snapshot', async (t) => {
  const { base } = await boot(t);
  const patched = await (await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gateway: { mock: false }, upstream: { balancePath: '/api/quota' }, automation: { time: '07:15' } })
  })).json();
  assert.equal(patched.settings.gateway.mock, false);
  assert.equal(patched.mode, 'live');
  assert.equal(patched.settings.upstream.balancePath, '/api/quota');
  assert.equal(patched.settings.automation.time, '07:15');
  assert.ok(patched.automation.nextRunAt);
});

test('quota, stats and cooldown survive a restart', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wb-persist-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  const first = await createServer({ dataDir });
  await new Promise((resolve) => first.server.listen(0, '127.0.0.1', resolve));
  const portOne = first.server.address().port;
  const created = await (await fetch(`http://127.0.0.1:${portOne}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: '持久化', total: 2500, used: 300 })
  })).json();
  await fetch(`http://127.0.0.1:${portOne}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], estimatedTokens: 120 })
  });
  await fetch(`http://127.0.0.1:${portOne}/api/accounts/${created.account.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cooldownUntil: new Date(Date.now() + 600000).toISOString() })
  });
  await first.close();

  const second = await createServer({ dataDir });
  await new Promise((resolve) => second.server.listen(0, '127.0.0.1', resolve));
  const portTwo = second.server.address().port;
  const state = await (await fetch(`http://127.0.0.1:${portTwo}/api/state`)).json();
  await second.close();

  const account = state.accounts[0];
  assert.equal(account.quota.total, 2500);
  assert.equal(account.quota.used, 420);
  assert.equal(account.stats.requests, 1);
  assert.ok(account.stats.lastSuccessAt);
  assert.equal(account.cooling, true);
});

test('scan login bridge turns captured cookies into an account', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wb-login-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  let bridgeState = 'pending';
  const bridge = {
    async start() { return { id: 'login-test-1' }; },
    async poll() {
      return bridgeState === 'done'
        ? { state: 'done', cookieHeader: 'sid=secret-cookie; uid=7' }
        : { state: bridgeState };
    },
    async cancel() { bridgeState = 'cancelled'; return { ok: true }; }
  };

  const app = await createServer({ dataDir, loginBridge: bridge });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); });

  const started = await (await fetch(`${base}/api/login/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: '扫码号', url: 'https://example.com/login' })
  })).json();
  assert.equal(started.ok, true);

  const pending = await (await fetch(`${base}/api/login/status?id=${started.id}`)).json();
  assert.equal(pending.state, 'pending');
  const snapshotPending = await (await fetch(`${base}/api/state`)).json();
  assert.equal(snapshotPending.pendingLogins.length, 1);

  bridgeState = 'done';
  const done = await (await fetch(`${base}/api/login/status?id=${started.id}`)).json();
  assert.equal(done.state, 'done');
  assert.equal(done.account.label, '扫码号');
  assert.equal(done.account.hasSecret, true);

  const secrets = await readFile(join(dataDir, 'secrets.json'), 'utf8');
  assert.equal(secrets.includes('secret-cookie'), false);

  const after = await (await fetch(`${base}/api/state`)).json();
  assert.equal(after.accounts.length, 1);
  assert.equal(after.pendingLogins.length, 0);
});

test('accounts keep provider, region and daily usage', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wb-provider-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  const app = await createServer({ dataDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); });

  await fetch(`${base}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'codebuddy-1', provider: 'codebuddy', region: '国服', total: 5000, used: 0 })
  });

  await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], estimatedTokens: 640 })
  });

  const state = await (await fetch(`${base}/api/state`)).json();
  const account = state.accounts[0];
  assert.equal(account.provider, 'codebuddy');
  assert.equal(account.region, '国服');
  assert.ok(account.stats.todayTokens >= 640);
  assert.ok(account.stats.todayDate);

  const models = await (await fetch(`${base}/api/accounts/${account.id}/models`)).json();
  assert.equal(models.provider, 'codebuddy');
  assert.ok(models.gatewayModels.includes('workbuddy-gateway-v1'));
});

test('scan login sniffs upstream paths into settings', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wb-sniff-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  const requests = [
    { url: 'https://up.acme.test/v1/chat/completions', method: 'POST', status: 200, body: '{"messages":[]}' },
    { url: 'https://up.acme.test/api/checkin', method: 'POST', status: 200, body: '{"source":"web"}' },
    { url: 'https://up.acme.test/api/tasks', method: 'GET', status: 200 },
    { url: 'https://up.acme.test/api/reward/claim', method: 'POST', status: 200 },
    { url: 'https://up.acme.test/static/app.js', method: 'GET', status: 200 },
    { url: 'https://up.acme.test/track/report', method: 'POST', status: 204 }
  ];

  const bridge = {
    async start() { return { id: 'sniff-1' }; },
    async poll() { return { state: 'done', cookieHeader: 'sid=xyz', requests }; },
    async cancel() { return { ok: true }; }
  };

  const app = await createServer({ dataDir, loginBridge: bridge });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); });

  const started = await (await fetch(`${base}/api/login/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: '嗅探号', url: 'https://up.acme.test/login' })
  })).json();

  const done = await (await fetch(`${base}/api/login/status?id=${started.id}`)).json();
  assert.equal(done.state, 'done');

  const upstream = done.snapshot.settings.upstream;
  assert.equal(upstream.baseUrl, 'https://up.acme.test');
  assert.equal(upstream.chatPath, '/v1/chat/completions');
  assert.equal(upstream.checkinPath, '/api/checkin');
  assert.equal(upstream.tasksPath, '/api/tasks');
  assert.equal(upstream.claimPath, '/api/reward/claim');
  assert.equal(upstream.checkin.method, 'POST');
});

test('account exposes per-account automation switches and health', async (t) => {
  const { base } = await boot(t);
  const created = await addAccount(base, { label: '开关号', total: 800, used: 100, secret: 'sid=sw' });
  const account = created.account;
  assert.deepEqual(account.auto, { checkin: true, tasks: true, claim: true, keepalive: true, inspect: true });
  assert.equal(account.health, 'unknown');
  assert.equal(account.batch, '');
  assert.equal(account.role, '');

  const toggled = await (await fetch(`${base}/api/accounts/${account.id}/auto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ checkin: false, claim: false })
  })).json();
  assert.equal(toggled.account.auto.checkin, false);
  assert.equal(toggled.account.auto.claim, false);
  assert.equal(toggled.account.auto.tasks, true);
});

test('disabling a step for one account skips it during batch run', async (t) => {
  const { base } = await boot(t);
  const a = (await addAccount(base, { label: '甲', total: 900, used: 200, secret: 'sid=a' })).account;
  const b = (await addAccount(base, { label: '乙', total: 900, used: 200, secret: 'sid=b' })).account;

  await fetch(`${base}/api/accounts/${a.id}/auto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ checkin: false })
  });

  const result = await (await fetch(`${base}/api/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'checkin', ids: [a.id, b.id] })
  })).json();

  assert.equal(result.ok, true);
  const first = result.results.find((item) => item.accountId === a.id);
  assert.equal(first.skipped, true);
  assert.equal(first.status, 'skipped');
  const second = result.results.find((item) => item.accountId === b.id);
  assert.notEqual(second.status, 'skipped');
});

test('bulk inspect fills health and lastInspectAt for every account', async (t) => {
  const { base } = await boot(t);
  await addAccount(base, { label: '巡检甲', total: 1200, used: 300, secret: 'sid=x' });
  await addAccount(base, { label: '巡检乙', total: 1500, used: 900, secret: 'sid=y' });

  const result = await (await fetch(`${base}/api/inspect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  })).json();
  assert.equal(result.ok, true);
  for (const account of result.snapshot.accounts) {
    assert.equal(account.health, 'healthy');
    assert.ok(account.lastInspectAt);
  }
});

test('bulk enable/disable/delete and settings survive restart', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'wb-bulk-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));

  const app = await createServer({ dataDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); });

  const a = (await addAccount(base, { label: '甲', total: 500, used: 0, secret: 'sid=1' })).account;
  const b = (await addAccount(base, { label: '乙', total: 500, used: 0, secret: 'sid=2' })).account;

  const disabled = await (await fetch(`${base}/api/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'disable', ids: [a.id] })
  })).json();
  assert.equal(disabled.count, 1);
  assert.equal(disabled.snapshot.accounts.find((item) => item.id === a.id).disabled, true);

  const removed = await (await fetch(`${base}/api/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'delete', ids: [b.id] })
  })).json();
  assert.equal(removed.count, 1);
  assert.equal(removed.snapshot.accounts.length, 1);

  await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ automation: { keepalive: { intervalMinutes: 30 }, inspect: { intervalMinutes: 90 } } })
  });
  await app.close();

  const reopened = await createServer({ dataDir });
  await new Promise((resolve) => reopened.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await reopened.close(); });
  const state = reopened.snapshot();
  assert.equal(state.settings.automation.keepalive.intervalMinutes, 30);
  assert.equal(state.settings.automation.inspect.intervalMinutes, 90);
  assert.equal(state.accounts.length, 1);
});

test('gateway models endpoint lists scheduling aliases', async (t) => {
  const { base } = await boot(t);
  const listed = await (await fetch(`${base}/v1/models`)).json();
  const ids = listed.data.map((item) => item.id);
  assert.ok(ids.includes('workbuddy-gateway-v1'));
  assert.ok(ids.includes('deepseek-v4-pro'));
  assert.ok(ids.includes('deepseek-v4.1-flash'));
});

test('stream:true is answered with real SSE for all three endpoints', async (t) => {
  const { base } = await boot(t);
  await addAccount(base, { label: '流式号', total: 3000, used: 0 });

  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.1', messages: [{ role: 'user', content: 'stream please' }], stream: true })
  });
  assert.equal(chat.status, 200);
  assert.match(chat.headers.get('content-type'), /text\/event-stream/);
  const chatText = await chat.text();
  assert.ok(chatText.includes('chat.completion.chunk'), '应为 chunk 而非整包 JSON');
  assert.ok(chatText.includes('data: [DONE]'), '流必须显式收尾');

  const anthropic = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.1', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }], stream: true })
  });
  assert.match(anthropic.headers.get('content-type'), /text\/event-stream/);
  const anthropicText = await anthropic.text();
  for (const event of ['message_start', 'content_block_delta', 'message_stop']) {
    assert.ok(anthropicText.includes(`event: ${event}`), `缺少 ${event} 事件`);
  }

  const responses = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.1', input: 'hi', stream: true })
  });
  assert.match(responses.headers.get('content-type'), /text\/event-stream/);
  const responsesText = await responses.text();
  assert.ok(responsesText.includes('response.output_text.delta'));
  assert.ok(responsesText.includes('response.completed'));
});
