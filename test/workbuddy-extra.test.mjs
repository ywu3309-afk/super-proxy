import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 校验客户端逆向得到的新能力：三段式额度明细、成长体系领奖、排队预检换号、模型倍率目录
const MOCK_PORT = 8801;
process.env.WB_BASE_CN = `http://127.0.0.1:${MOCK_PORT}`;
process.env.WB_CLAIM_BASE_CN = `http://127.0.0.1:${MOCK_PORT}/activity/growth/tasks/{code}/claim`;

const { createServer } = await import('../server.mjs');

const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {})
}).then((response) => response.json());

test('client-derived features: sliced packages, growth claim, queue probe, catalog', async (t) => {
  const mock = spawn(process.execPath, ['scripts/mock-workbuddy.mjs', String(MOCK_PORT)], {
    cwd: process.cwd(),
    stdio: 'ignore'
  });
  t.after(() => mock.kill());

  const dataDir = await mkdtemp(join(tmpdir(), 'wb-extra-'));
  const app = await createServer({ dataDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ gateway: { mock: false, queueProbe: true } })
  });

  // 前台等 mock 起来
  for (let index = 0; index < 40; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${MOCK_PORT}/v2/chat/queue/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      if (response.ok) break;
    } catch { /* 继续等 */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const makeAccount = async (label, uid) => {
    const created = await post(base, '/api/accounts', {
      label,
      authType: 'workbuddy',
      secret: JSON.stringify({ accessToken: 'tok', refreshToken: 'ref', realm: 'cn', uid }),
      total: 0,
      used: 0
    });
    assert.equal(created.ok, true);
    return created.account.id;
  };

  const busyId = await makeAccount('排队号', 'u-busy');
  const okId = await makeAccount('空闲号', 'u-ok');

  for (const id of [busyId, okId]) {
    const refreshed = await post(base, `/api/accounts/${id}/refresh`, {});
    assert.equal(refreshed.ok, true);
  }

  // 1) 三段式额度：付费包 1200/700 + 免费切片包 300/200
  const snapshot = await (await fetch(`${base}/api/state`)).json();
  const busyAccount = snapshot.accounts.find((item) => item.id === busyId);
  assert.equal(busyAccount.quota.total, 1500);
  assert.equal(busyAccount.available, 900);

  // 2) 领奖：走成长体系（旅行奖励）+ 成长任务
  const claimed = await post(base, `/api/accounts/${busyId}/claim`, {});
  assert.equal(claimed.ok, true);
  const claimStep = (claimed.steps || []).find((step) => step.step === 'claim');
  assert.match(String(claimStep?.message || ''), /旅行奖励已领/);
  assert.match(String(claimStep?.message || ''), /连签 5 天/);

  // 3) 模型目录：带 credits 倍率
  const catalog = await (await fetch(`${base}/api/catalog`)).json();
  assert.equal(catalog.ok, true);
  const glm = catalog.catalog.find((item) => item.id === 'glm-5.1');
  assert.equal(glm.credits, 1.06);
  assert.ok(catalog.catalog.length >= 20);

  const models = await (await fetch(`${base}/v1/models`)).json();
  // /v1/models 只对外暴露默认别名 + V4/V4.1（DSH 拉目录用），不再透出上游全量清单
  const ids = models.data.map((item) => item.id);
  assert.ok(ids.includes('workbuddy-gateway-v1'));
  assert.ok(ids.includes('deepseek-v4-pro'));
  assert.ok(ids.includes('deepseek-v4.1-flash'));
  assert.ok(!ids.includes('glm-5.1'), 'glm 不在对外清单里');
  // text-to-image 的模型不进对话清单，但仍在目录里
  assert.equal(models.data.some((item) => item.id === 'hunyuan-image-v3.0'), false);

  // 4) 排队预检：busyId 排队 → 调度器换到 okId
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.1', messages: [{ role: 'user', content: 'ping' }] })
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get('x-scheduled-account-id'), okId);
  const chatJson = await chat.json();
  assert.equal(chatJson.choices[0].message.content, 'pong from workbuddy');

  const afterChat = await (await fetch(`${base}/api/state`)).json();
  const cooled = afterChat.accounts.find((item) => item.id === busyId);
  assert.equal(cooled.cooling, true, '排队中的账号应被冷冻');
  assert.match(String(cooled.lastError?.reason || ''), /queue:/);
});
