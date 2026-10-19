import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createServer } = await import('../server.mjs');

const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {})
}).then(async (response) => ({ status: response.status, json: await response.json() }));

async function boot(dataDir) {
  const app = await createServer({ dataDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

test('vault: 口令加密导出，能在另一台实例上还原账号', async (t) => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'vault-src-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'vault-dst-'));
  const source = await boot(sourceDir);
  const target = await boot(targetDir);
  t.after(async () => {
    await source.app.close();
    await target.app.close();
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  });

  // 源端建两个账号（cookie 类型，不触发真实请求）
  for (const [label, secret] of [['主号', 'sid=alpha-secret'], ['备用', 'sid=beta-secret']]) {
    const created = await post(source.base, '/api/accounts', {
      label,
      authType: 'cookie',
      secret,
      total: 1000,
      used: 200
    });
    assert.equal(created.status, 201);
  }

  // 口令太短被拒
  const short = await post(source.base, '/api/vault/export', { password: '123' });
  assert.equal(short.status, 400);
  assert.equal(short.json.error, 'password_too_short');

  const exported = await post(source.base, '/api/vault/export', { password: 'pw-123456' });
  assert.equal(exported.status, 200);
  assert.equal(exported.json.count, 2);
  const vault = exported.json.vault;
  assert.equal(vault.marker, 'workbuddy-gateway-vault');
  assert.equal(vault.kdf, 'scrypt');
  // 密文里不能出现明文凭据
  const blobText = JSON.stringify(vault);
  assert.equal(blobText.includes('alpha-secret'), false);
  assert.equal(blobText.includes('beta-secret'), false);

  // 错口令解不开
  const wrong = await post(target.base, '/api/vault/import', { password: 'wrong-pass', vault });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error, 'vault_open_failed');

  // 正确口令导入到另一台实例
  const imported = await post(target.base, '/api/vault/import', { password: 'pw-123456', vault });
  assert.equal(imported.status, 200);
  assert.equal(imported.json.results.imported, 2);
  assert.equal(imported.json.results.failed, 0);

  const state = await (await fetch(`${target.base}/api/state`)).json();
  assert.equal(state.accounts.length, 2);
  const labels = state.accounts.map((item) => item.label).sort();
  assert.deepEqual(labels, ['主号', '备用']);
  // 额度随账号一起迁移
  const main = state.accounts.find((item) => item.label === '主号');
  assert.equal(main.quota.total, 1000);
  assert.equal(main.available, 800);
  // 凭据已落到目标实例的保险箱
  assert.equal(main.hasSecret, true);
});
