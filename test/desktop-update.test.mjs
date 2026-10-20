import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { compareVersions, selectRelease, validateManifest } = require('../desktop/updater.cjs');
const { apiJSON, downloadAsset, readManifest } = require('../desktop/github.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'analysis'), { recursive: true });
const temp = mkdtempSync(join(root, 'analysis', 'desktop-update-test-'));
after(() => rmSync(temp, { recursive: true, force: true }));
const repository = 'ywu3309-afk/super-proxy';
const manifest = { schemaVersion: 1, repository, version: '1.2.0', platform: 'win32', arch: 'x64',
  root: 'WorkBuddy Gateway-win32-x64', executable: 'WorkBuddy Gateway.exe',
  asset: 'super-proxy-v1.2.0-win32-x64.zip', size: 100, sha256: 'a'.repeat(64) };
const release = { tag_name: 'v1.2.0', draft: false, prerelease: false, assets: [
  { id: 1, name: manifest.asset, state: 'uploaded', size: 100, digest: 'sha256:' + manifest.sha256 }
] };

test('semantic versions use numeric order, not lexicographic order', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
  assert.equal(compareVersions('1.0.9', '1.1.0'), -1);
  for (const bad of ['latest', '1.2', 'v1.2.3', '1.2.3-rc1', '01.2.3']) assert.throws(() => compareVersions(bad, '1.0.0'));
});
test('only the newest stable, non-draft release is selected', () => {
  const picked = selectRelease([
    { ...release, tag_name: 'v9.0.0', draft: true }, { ...release, tag_name: 'v8.0.0', prerelease: true },
    { ...release, tag_name: 'nightly' }, { ...release, tag_name: 'v1.9.0' }, { ...release, tag_name: 'v1.10.0' }
  ]);
  assert.equal(picked.tag_name, 'v1.10.0');
  assert.equal(selectRelease([]), null);
});
test('valid manifest is bound to the repository, platform, version, size, and digest', () => {
  assert.equal(validateManifest(manifest, release, repository).id, 1);
  for (const change of [{ repository: 'other/repo' }, { version: '1.2.1' }, { platform: 'darwin' },
    { root: '../escape' }, { asset: '../data.zip' }, { size: 101 }, { sha256: 'not-a-hash' }]) {
    assert.throws(() => validateManifest({ ...manifest, ...change }, release, repository));
  }
  assert.throws(() => validateManifest(manifest, { ...release, assets: [] }, repository));
});
test('a GitHub-reported digest mismatch is rejected', () => {
  assert.throws(() => validateManifest(manifest, { ...release, assets: [{ ...release.assets[0], digest: 'sha256:' + 'b'.repeat(64) }] }, repository));
});
test('downloading verifies the actual content and never forwards auth to the asset host', async () => {
  const original = globalThis.fetch;
  const bytes = Buffer.from('desktop-update-fixture');
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, hasAuth: !!options.headers.Authorization });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } }) : new Response(bytes);
  };
  try {
    const target = join(temp, 'valid.zip');
    await downloadAsset(repository, { id: 1 }, 'fixture-only', target, {
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')
    });
    assert.deepEqual(readFileSync(target), bytes);
    assert.equal(calls[0].hasAuth, true);
    assert.equal(calls[1].hasAuth, false);
  } finally { globalThis.fetch = original; }
});
test('public GitHub updates do not require or send an authorization header', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, hasAuth: !!options.headers.Authorization });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.deepEqual(await apiJSON(repository, '/releases?per_page=30', ''), { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hasAuth, false);
  } finally { globalThis.fetch = original; }
});
test('a redirect outside GitHub is refused before contacting the new host', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://example.invalid/fixture' } }); };
  try {
    await assert.rejects(downloadAsset(repository, { id: 1 }, 'fixture-only', join(temp, 'bad-host.zip'), manifest));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('lookalike domains, insecure URLs, credentials, and nonstandard ports are refused', async () => {
  const original = globalThis.fetch;
  try {
    for (const location of ['https://githubusercontent.com.evil.invalid/fixture',
      'https://evilgithubusercontent.com/fixture', 'http://release-assets.githubusercontent.com/fixture',
      'https://user:password@api.github.com/fixture', 'https://release-assets.githubusercontent.com:444/fixture']) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location } }); };
      const target = join(temp, 'invalid-redirect.zip');
      await assert.rejects(downloadAsset(repository, { id: 1 }, 'fixture-only', target, manifest), /不属于 GitHub/);
      assert.equal(calls, 1);
      assert.equal(existsSync(target), false);
    }
  } finally { globalThis.fetch = original; }
});
test('a bad checksum or oversized download is rejected', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from('fixture'));
  try {
    await assert.rejects(downloadAsset(repository, { id: 1 }, 'fixture-only', join(temp, 'bad-hash.zip'), { size: 7, sha256: '0'.repeat(64) }));
    await assert.rejects(downloadAsset(repository, { id: 1 }, 'fixture-only', join(temp, 'too-large.zip'), { size: 1, sha256: '0'.repeat(64) }));
    await assert.rejects(downloadAsset(repository, { id: 1 }, 'fixture-only', join(temp, 'too-small.zip'), { size: 8, sha256: '0'.repeat(64) }));
    for (const name of ['bad-hash.zip', 'too-large.zip', 'too-small.zip']) assert.equal(existsSync(join(temp, name)), false);
  } finally { globalThis.fetch = original; }
});

test('an existing destination is neither overwritten nor removed on failure', async () => {
  const original = globalThis.fetch;
  const target = join(temp, 'existing.zip');
  const bytes = Buffer.from('keep-existing-file');
  writeFileSync(target, bytes);
  globalThis.fetch = async () => new Response(Buffer.from('fixture'));
  try {
    await assert.rejects(downloadAsset(repository, { id: 1 }, 'fixture-only', target, manifest), { code: 'EEXIST' });
    assert.deepEqual(readFileSync(target), bytes);
  } finally { globalThis.fetch = original; }
});

// Fake only timeout timers: stream/file I/O still runs normally, and no network is used.
// Waiting for setImmediate lets async stream consumption reset its watchdog after each chunk.
async function flushIO() {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

function controlledFetch() {
  let body;
  let signal;
  let ended = false;
  return {
    fetch: async (url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({
        start(controller) {
          body = controller;
          signal.addEventListener('abort', () => {
            if (!ended) { ended = true; controller.error(new Error('secret-token https://asset.invalid/?signature=secret')); }
          }, { once: true });
        },
        cancel() { ended = true; }
      }));
    },
    chunk(bytes) { body.enqueue(bytes); },
    close() { ended = true; body.close(); },
    fail() { ended = true; body.error(new Error('secret-token https://asset.invalid/?signature=secret')); },
    get signal() { return signal; }
  };
}

test('continuous slow progress can exceed three minutes without cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  const fixture = controlledFetch();
  globalThis.fetch = fixture.fetch;
  const target = join(temp, 'slow-continuous.zip');
  const bytes = Buffer.from('1234');
  try {
    const pending = downloadAsset(repository, { id: 1 }, 'fixture-only', target, {
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')
    });
    await flushIO();
    for (const byte of bytes) {
      t.mock.timers.tick(120000);
      assert.equal(fixture.signal.aborted, false);
      fixture.chunk(Uint8Array.of(byte));
      await flushIO();
    }
    fixture.close();
    await pending;
    assert.deepEqual(readFileSync(target), bytes);
  } finally { globalThis.fetch = original; t.mock.timers.reset(); }
});

test('a stalled body times out and removes only the newly created destination', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  const fixture = controlledFetch();
  globalThis.fetch = fixture.fetch;
  const target = join(temp, 'stalled.zip');
  try {
    const pending = downloadAsset(repository, { id: 1 }, 'secret-token', target, manifest);
    const rejection = assert.rejects(pending, /^Error: 下载更新附件中断或长时间无进度，请重试$/);
    await flushIO();
    fixture.chunk(Uint8Array.of(1));
    await flushIO();
    t.mock.timers.tick(179999);
    assert.equal(fixture.signal.aborted, false);
    t.mock.timers.tick(1);
    await rejection;
    assert.equal(fixture.signal.aborted, true);
    assert.equal(existsSync(target), false);
  } finally { globalThis.fetch = original; t.mock.timers.reset(); }
});

test('a network body failure is sanitized and removes the newly created file', async () => {
  const original = globalThis.fetch;
  const fixture = controlledFetch();
  globalThis.fetch = fixture.fetch;
  const target = join(temp, 'broken-network.zip');
  try {
    const pending = downloadAsset(repository, { id: 1 }, 'secret-token', target, manifest);
    const rejection = assert.rejects(pending, /^Error: 下载更新附件中断或长时间无进度，请重试$/);
    await flushIO();
    fixture.chunk(Uint8Array.of(1));
    await flushIO();
    fixture.fail();
    await rejection;
    assert.equal(existsSync(target), false);
  } finally { globalThis.fetch = original; }
});

test('waiting for response headers has its own bounded timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  let signal;
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new Error('secret-token signed-url')), { once: true });
  });
  const target = join(temp, 'header-timeout.zip');
  try {
    const rejection = assert.rejects(downloadAsset(repository, { id: 1 }, 'secret-token', target, manifest),
      /^Error: 下载更新附件失败，请检查网络后重试$/);
    t.mock.timers.tick(29999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await rejection;
    assert.equal(existsSync(target), false);
  } finally { globalThis.fetch = original; t.mock.timers.reset(); }
});

test('manifest bodies also time out when there is no first byte', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const original = globalThis.fetch;
  const fixture = controlledFetch();
  globalThis.fetch = fixture.fetch;
  try {
    const rejection = assert.rejects(readManifest(repository, { id: 1, size: 100 }, 'fixture-only'), /长时间无进度/);
    await flushIO();
    t.mock.timers.tick(180000);
    await rejection;
    assert.equal(fixture.signal.aborted, true);
  } finally { globalThis.fetch = original; t.mock.timers.reset(); }
});
test('source and lockfile share one desktop version and the private update source', () => {
  const metadata = JSON.parse(readFileSync(join(root, 'package.json')));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
  assert.equal(metadata.version, lock.version);
  assert.equal(metadata.version, lock.packages[''].version);
  assert.equal(metadata.updateRepository, repository);
});
