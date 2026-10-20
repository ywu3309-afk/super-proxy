// 发布已构建的版本化桌面附件。只使用本机已授权的 GitHub 凭据，不保存 Token。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { loadToken, apiJSON } = require('../desktop/github.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const repository = metadata.updateRepository;
const tag = `v${metadata.version}`;
const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
const section = changelog.split(/^## /m).slice(1).find((entry) =>
  entry.startsWith(`${metadata.version}（`) || entry.startsWith(`${metadata.version}\n`) || entry.startsWith(`${metadata.version}\r\n`));
if (!section) throw new Error('The version must have a CHANGELOG entry before publishing');
const changes = section.slice(section.indexOf('\n') + 1).trim();
const releaseBody = `## 超级反代 ${tag}\n\n${changes}\n\n### 桌面安装与更新\n\n- 版本化 Windows x64 便携桌面包，解压后运行 WorkBuddy Gateway.exe。\n- 桌面菜单“软件 → 检查桌面更新”从此 GitHub Release 检查版本，需要本机 GitHub 授权。\n- 更新包使用 SHA-256 校验；账号数据与 GitHub 凭据不包含在附件中。\n- 首次从无更新功能的旧版升级时，请先安装本版并保留 data 目录。\n- 后续更新由用户确认后安装，保留账号和设置；上一版程序保留用于回滚。`;
const out = join(root, 'release', `publish-${tag}`);
const manifest = JSON.parse(await readFile(join(out, 'update-manifest.json'), 'utf8'));
if (manifest.version !== metadata.version || manifest.repository !== repository ||
    manifest.asset !== `super-proxy-${tag}-win32-x64.zip`) throw new Error('Release manifest does not match the source version');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
if (git('status', '--porcelain')) throw new Error('Commit and review all source changes before publishing');
const head = git('rev-parse', 'HEAD');
if (manifest.commit !== head) throw new Error('The release was built from a different source commit; rebuild before publishing');
if (git('rev-parse', `${tag}^{}`) !== head) throw new Error('The version tag must identify the current commit');
if (git('remote', 'get-url', 'origin') !== `https://github.com/${repository}.git`) throw new Error('Origin must be the configured private repository');
const token = loadToken(repository, { required: true });
const repo = await apiJSON(repository, '', token);
if (!repo.permissions?.push) throw new Error('Publishing requires repository write permission');
// 复用已授权的官方 API 核验远端标签，不依赖另一条 github.com Git 传输链路。
let remoteTag = (await apiJSON(repository, `/git/ref/tags/${encodeURIComponent(tag)}`, token)).object;
for (let depth = 0; remoteTag.type === 'tag' && depth < 4; depth++) {
  remoteTag = (await apiJSON(repository, `/git/tags/${remoteTag.sha}`, token)).object;
}
if (remoteTag.type !== 'commit' || remoteTag.sha !== head) throw new Error('Push the matching version tag before publishing');
const archivePath = join(out, manifest.asset);
const hash = createHash('sha256');
for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
if (hash.digest('hex') !== manifest.sha256 || (await stat(archivePath)).size !== manifest.size) throw new Error('Release archive changed after preparation');
const releases = await apiJSON(repository, '/releases?per_page=100', token);
let release = releases.find((entry) => entry.tag_name === tag);
if (release && !release.draft) throw new Error('This version is already published; use a new version instead of overwriting it');
if (!release) release = await apiJSON(repository, '/releases', token, { method: 'POST', body: {
  tag_name: tag, target_commitish: head, name: `超级反代 ${tag}`, draft: true, prerelease: false,
  body: releaseBody
} });
if (release.body !== releaseBody) release = await apiJSON(repository, `/releases/${release.id}`, token, {
  method: 'PATCH', body: { body: releaseBody }
});
for (const name of [manifest.asset, 'update-manifest.json', 'SHA256SUMS']) {
  const file = join(out, name);
  const size = (await stat(file)).size;
  const localHash = createHash('sha256');
  for await (const chunk of createReadStream(file)) localHash.update(chunk);
  const digest = `sha256:${localHash.digest('hex')}`;
  const existing = (release.assets || []).find((entry) => entry.name === name);
  if (existing) {
    if (existing.size !== size || existing.digest !== digest) throw new Error('A draft attachment differs; inspect it before publishing');
    continue;
  }
  console.log(`[publish] Uploading ${name} (${size} bytes)`);
  const response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST', redirect: 'error', headers: {
      'User-Agent': 'SuperProxy-release-publisher', Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json', 'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      'Content-Length': String(size)
    }, body: Readable.toWeb(createReadStream(file)), duplex: 'half', signal: AbortSignal.timeout(600000)
  });
  if (!response.ok) throw new Error(`Attachment upload failed (HTTP ${response.status}); the release remains a draft`);
  const uploaded = await response.json();
  if (uploaded.state !== 'uploaded' || uploaded.size !== size || uploaded.digest !== digest) throw new Error('Uploaded attachment checksum mismatch; release remains a draft');
}
const published = await apiJSON(repository, `/releases/${release.id}`, token, { method: 'PATCH', body: { draft: false, make_latest: 'true' } });
console.log(JSON.stringify({ repository, version: metadata.version, tag, draft: published.draft, url: published.html_url }, null, 2));
