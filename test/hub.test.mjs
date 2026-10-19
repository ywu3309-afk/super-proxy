import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../server.mjs';
import { deriveId, machineId, sessionId, requestId, desktopFingerprint } from '../src/fingerprint.mjs';
import * as atrest from '../src/atrest.mjs';
import * as agents from '../src/agents.mjs';

async function boot(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'wb-hub-'));
  const app = await createServer({ dataDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { base, dataDir, app };
}

// ------------------------------------------------------------- 设备指纹
test('fingerprint: derive_id 稳定、UUIDv4 形状、账号之间互不相干', () => {
  const a = deriveId('uid-1', 'machine');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, deriveId('uid-1', 'machine'), '同一账号必须每次相同');
  assert.notEqual(a, deriveId('uid-2', 'machine'));
  assert.notEqual(machineId('uid-1'), sessionId('uid-1'));
  assert.match(requestId(), /^[0-9a-f]{32}$/, '请求 id 是 32 位无连字符 hex');

  const fp = desktopFingerprint('uid-1', '小明');
  assert.equal(fp.ideVersion, '5.8.4');
  assert.equal(fp.machineId, machineId('uid-1'));
  assert.equal(fp.sessionId, sessionId('uid-1'));
  assert.ok(fp.timestamp > 0);
});

// ------------------------------------------------------- at-rest 加密凭据
test('atrest: 信封按客户端 AAD 解开，密钥格式两种都认', () => {
  // 44 字符规范 base64 的 atRestSecretKey
  const b64 = Buffer.alloc(32, 7).toString('base64');
  assert.equal(b64.length, 44);
  const key = atrest.parseKeyText(b64);
  assert.equal(key.length, 32);
  assert.equal(atrest.parseKeyText(key.toString('hex')).toString('hex'), key.toString('hex'));
  assert.equal(atrest.deriveKeyId(key), atrest.deriveKeyId(atrest.parseKeyText(b64)));

  const envelope = atrest.seal(key, 'tok-abcdef', 'field');
  assert.ok(atrest.isEnvelope(envelope));
  assert.equal(atrest.decryptField(key, envelope, 'field'), 'tok-abcdef');
  assert.equal(atrest.decryptField(key, 'plain-token', 'field'), 'plain-token');

  // framing 不同 → AAD 不同 → 必须解不开
  assert.throws(() => atrest.decryptField(key, envelope, 'file'), /GCM/);

  // 换一把密钥 → keyId 不匹配
  const other = atrest.parseKeyText(Buffer.alloc(32, 9).toString('base64'));
  assert.throws(() => atrest.decryptField(other, envelope, 'field'), /keyId/);
});

// ------------------------------------------------------------ YAML 编辑
test('agents: YAML 增量写入保留注释与其它配置', () => {
  const original = [
    '# 我的 DSH 配置',
    'agent-default-model: {provider: deepseek, model: v4}',
    'llm-pi-ai:',
    '  providers:',
    '    deepseek:',
    '      api: openai-completions   # 手动配的',
    '',
    'other: 1',
    ''
  ].join('\n');
  const out = agents.yamlUpsertInline(original, 'llm-pi-ai.providers.wb-gateway', { api: 'openai-completions', baseURL: 'http://127.0.0.1:8787/v1' });
  assert.ok(out.includes('# 我的 DSH 配置'));
  assert.ok(out.includes('# 手动配的'));
  assert.ok(out.includes('wb-gateway: {"api":"openai-completions"'));
  assert.ok(out.includes('other: 1'));

  const creds = agents.yamlRefsUpsert('', 'WB_GATEWAY_API_KEY', 'sk-test');
  assert.equal(creds, 'refs:\n  WB_GATEWAY_API_KEY: sk-test\n');
  const creds2 = agents.yamlRefsUpsert(creds, 'WB_GATEWAY_API_KEY', 'sk-next');
  assert.ok(creds2.includes('sk-next'));
  assert.ok(!creds2.includes('sk-test'));
});

test('agents: DSH 一键配置写出 provider 与 credentials，还原是字节级回滚', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'wb-home-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'wb-agents-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  await mkdir(join(home, '.dsh'), { recursive: true });
  const settingsPath = join(home, '.dsh', 'settings.yaml');
  const original = '# 用户自己的注释\nllm-pi-ai:\n  providers:\n    existing:\n      api: openai\n';
  await writeFile(settingsPath, original, 'utf8');

  const result = agents.apply('dsh', {
    baseUrl: 'http://127.0.0.1:8787',
    baseUrlV1: 'http://127.0.0.1:8787/v1',
    apiKey: 'sk-local-test',
    model: 'glm-5.1',
    models: [{ id: 'glm-5.1', context_window: 200000, max_output: 32000, reasoning_efforts: ['low', 'high'] }]
  }, { dataDir, home });

  assert.equal(result.ok, true);
  const written = await readFile(settingsPath, 'utf8');
  assert.ok(written.includes('# 用户自己的注释'), '注释不能被抹掉');
  assert.ok(written.includes('wb-gateway:'), '要写入 provider');
  assert.ok(written.includes('"contextWindow":200000'));
  assert.ok(written.includes('"high":"high"'), '思考档位要声明');
  assert.ok(written.includes('agent-default-model: {"provider":"wb-gateway"'), '默认模型指向网关');

  const creds = await readFile(join(home, '.dsh', '.credentials.yaml'), 'utf8');
  assert.ok(creds.includes('WB_GATEWAY_API_KEY: sk-local-test'));

  // 再次 apply 应该幂等，不重复堆 provider
  agents.apply('dsh', { baseUrl: 'http://127.0.0.1:8787', baseUrlV1: 'http://127.0.0.1:8787/v1', apiKey: 'sk-local-test', model: 'glm-5.1', models: [] }, { dataDir, home });
  const twice = await readFile(settingsPath, 'utf8');
  assert.equal(twice.split('wb-gateway:').length - 1, 1, 'provider 只能出现一次');

  // 还原
  agents.restore('dsh', { dataDir, home });
  assert.equal(await readFile(settingsPath, 'utf8'), original, '必须字节级回到原件');
  assert.equal(existsSync(join(home, '.dsh', '.credentials.yaml')), false, '网关新建的文件要被清掉');
});

test('agents: overview 能识别已配置与外部改动', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'wb-home2-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'wb-agents2-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'settings.json'), '{"env":{"FOO":"1"}}\n', 'utf8');

  agents.apply('claude', {
    baseUrl: 'http://127.0.0.1:8787',
    baseUrlV1: 'http://127.0.0.1:8787/v1',
    apiKey: 'sk-abc',
    model: 'glm-5.1',
    models: []
  }, { dataDir, home });

  const data = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(data.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8787', 'Claude Code 要裸根，不带 /v1');
  assert.equal(data.env.ANTHROPIC_AUTH_TOKEN, 'sk-abc');
  assert.equal(data.env.FOO, '1', '用户原有键要保留');

  let view = agents.overview(dataDir, home);
  assert.equal(view.claude.applied, true);
  assert.equal(view.claude.external, false);

  await writeFile(join(home, '.claude', 'settings.json'), '{"env":{"FOO":"2"}}\n', 'utf8');
  view = agents.overview(dataDir, home);
  assert.equal(view.claude.external, true, '手改过要能识别出来');
});

// --------------------------------------------------------- 定址路由 /u/
test('gateway: /u/<ref>/v1 锁定指定账号，未知 ref 直接 404', async (t) => {
  const { base } = await boot(t);
  const mk = async (label, uid) => (await fetch(`${base}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label, uid, total: 3000, used: 0 })
  })).json();

  const first = await mk('甲号', 'uid-alpha-1111');
  const second = await mk('乙号', 'uid-beta-2222');

  const call = async (ref) => fetch(`${base}/u/${encodeURIComponent(ref)}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }] })
  });

  const pinned = await call('uid-beta-2222');
  assert.equal(pinned.status, 200);
  assert.equal(pinned.headers.get('x-scheduled-account-id'), second.account.id);

  const byPrefix = await call('uid-alpha');
  assert.equal(byPrefix.headers.get('x-scheduled-account-id'), first.account.id);

  const byName = await call('乙号');
  assert.equal(byName.headers.get('x-scheduled-account-id'), second.account.id);

  const missing = await call('nobody');
  assert.equal(missing.status, 404);
  const body = await missing.json();
  assert.match(body.error.message, /not found/);
});

test('server: /api/agents 与 /api/atrest 可用', async (t) => {
  const { base } = await boot(t);
  const listed = await (await fetch(`${base}/api/agents`)).json();
  assert.equal(listed.ok, true);
  assert.ok(listed.clients.dsh, '要有 DSH 这一项');
  assert.equal(listed.clients.dsh.applied, false);

  const status = await (await fetch(`${base}/api/atrest`)).json();
  assert.equal(status.ok, true);
  assert.equal(status.key, false);
  assert.equal(typeof status.keyblob, 'boolean');

  const rejected = await fetch(`${base}/api/atrest/key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'not-a-key' })
  });
  assert.equal(rejected.status, 400);
});

// --------------------------------------------------- 内存回收脚本可打包
test('keyhunt: 打包进 app.asar 后脚本会物化到临时目录', async () => {
  const { resolveScript, readScript } = await import('../src/keyhunt.mjs');
  const source = readScript();
  assert.match(source, /ReadProcessMemory/, '脚本本体要有内存读取实现');
  assert.match(source, /VirtualQueryEx/);

  const inAsar = resolveScript({ force: true });
  assert.ok(inAsar.startsWith(tmpdir()), 'asar 内的路径 PowerShell 打不开，必须换到临时目录');
  assert.ok(existsSync(inAsar), '物化后的文件要真的存在');
  assert.equal(await readFile(inAsar, 'utf8'), source, '物化不得改动脚本内容');

  const dev = resolveScript({ force: false });
  assert.ok(existsSync(dev), '开发态的脚本路径也要可读');
});

// ------------------------------------------------- 别名换算与上游错误摘要
test('gateway: 对外别名换算成上游模型 ID，原始 ID 原样透传', async () => {
  const { resolveUpstreamModel, GATEWAY_ALIAS, upstreamErrorBrief } = await import('../src/upstream.mjs');
  assert.equal(resolveUpstreamModel('workbuddy-gateway-v1'), 'deepseek-v4-pro');
  assert.equal(resolveUpstreamModel('workbuddy-gateway-max'), 'deepseek-v4-pro');
  assert.equal(resolveUpstreamModel('workbuddy-gateway-fast'), 'deepseek-v4.1-flash');
  for (const [alias, target] of Object.entries(GATEWAY_ALIAS)) {
    assert.ok(alias && target && alias !== target, '别名必须换成别的东西');
  }
  assert.equal(resolveUpstreamModel('glm-5.1'), 'glm-5.1', '真实模型名不许被改写');
  assert.equal(resolveUpstreamModel(''), '');
  assert.equal(resolveUpstreamModel(undefined), '');

  const body = JSON.stringify({
    code: 11150,
    msg: 'the reasoning effort value is not supported by the current model',
    displayMsg: { zh: '模型不支持该思考强度，请调整' }
  });
  const brief = upstreamErrorBrief({ status: 400, body });
  assert.match(brief, /^http_400\(11150\)/, '要带上上游错误码');
  assert.match(brief, /思考强度/, '要给出中文原因');
  assert.ok(brief.length < 140, '摘要不能太长');
  assert.equal(upstreamErrorBrief({ status: 502, body: '' }), 'http_502');
});

test('gateway: 别名在模拟模式下也能正常返回（不再 500）', async (t) => {
  const { base } = await boot(t);
  await fetch(`${base}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: '别名测试号', total: 5000, used: 0 })
  });

  const models = await (await fetch(`${base}/v1/models`)).json();
  const ids = models.data.map((item) => item.id);
  assert.ok(ids.includes('workbuddy-gateway-v1'));
  assert.ok(ids.includes('deepseek-v4-pro'));
  assert.ok(ids.includes('deepseek-v4.1-flash'));
  assert.ok(!ids.includes('glm-5v-turbo'), '上游完整目录不外泄，DSH 下拉框只看到 DeepSeek');

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'workbuddy-gateway-max', messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, 'workbuddy-gateway-max', '回显仍用客户端请求的别名');
});
