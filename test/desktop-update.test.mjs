import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { compareVersions, selectRelease, validateManifest } = require('../desktop/updater.cjs');
const { downloadAsset } = require('../desktop/github.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'analysis'), { recursive: true });
const temp = mkdtempSync(join(root, 'analysis', 'desktop-update-test-'));
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
test('a redirect outside GitHub is refused before contacting the new host', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://example.invalid/fixture' } }); };
  try {
    await assert.rejects(downloadAsset(repository, { id: 1 }, 'fixture-only', join(temp, 'bad-host.zip'), manifest));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test('a bad checksum or oversized download is rejected', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from('fixture'));
  try {
    await assert.rejects(downloadAsset(repository, { id: 1 }, 'fixture-only', join(temp, 'bad-hash.zip'), { size: 7, sha256: '0'.repeat(64) }));
    await assert.rejects(downloadAsset(repository, { id: 1 }, 'fixture-only', join(temp, 'too-large.zip'), { size: 1, sha256: '0'.repeat(64) }));
  } finally { globalThis.fetch = original; }
});
test('source and lockfile share one desktop version and the private update source', () => {
  const metadata = JSON.parse(readFileSync(join(root, 'package.json')));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
  assert.equal(metadata.version, lock.version);
  assert.equal(metadata.version, lock.packages[''].version);
  assert.equal(metadata.updateRepository, repository);
});
