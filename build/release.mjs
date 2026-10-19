// 本机生成版本化更新附件，不运行收费 CI，不上传账号，不改动正在运行的软件。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(metadata.version) || lock.version !== metadata.version || lock.packages[''].version !== metadata.version) {
  throw new Error('package.json and package-lock.json versions must agree');
}
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
if (git('status', '--porcelain')) throw new Error('Commit reviewed source changes before preparing a release');
const commit = git('rev-parse', 'HEAD');
execFileSync(process.execPath, [join(root, 'build/package.mjs'), '--publish'], { cwd: root, stdio: 'inherit', windowsHide: true });
const out = join(root, 'release', `publish-v${metadata.version}`);
const program = join(out, 'WorkBuddy Gateway-win32-x64');
const asset = `super-proxy-v${metadata.version}-win32-x64.zip`;
const zip = join(out, asset);
if (existsSync(zip)) throw new Error('Release archive already exists; keep it for reproducibility or choose a new version');
const python = join(root, 'python', 'python.exe');
const zipCode = `import os,sys,zipfile\nfrom pathlib import Path\nroot=Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'x',zipfile.ZIP_DEFLATED,compresslevel=6) as z:\n for f in sorted(root.rglob('*')):\n  if f.is_symlink(): raise ValueError('Symlinks are not permitted in release packages')\n  if f.is_file():\n   if any(p.lower() in ('data','accounts','usage','electron-user-data','.git') for p in f.relative_to(root).parts): raise ValueError('Runtime data must not enter a release')\n   z.write(f,root.name+'/'+f.relative_to(root).as_posix())\n`;
execFileSync(python, ['-c', zipCode, program, zip], { cwd: root, stdio: 'inherit', windowsHide: true });
const hash = createHash('sha256');
for await (const chunk of createReadStream(zip)) hash.update(chunk);
const manifest = {
  schemaVersion: 1, repository: metadata.updateRepository, version: metadata.version, commit,
  platform: 'win32', arch: 'x64', root: 'WorkBuddy Gateway-win32-x64', executable: 'WorkBuddy Gateway.exe',
  asset, size: (await stat(zip)).size, sha256: hash.digest('hex')
};
await writeFile(join(out, 'update-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(out, 'SHA256SUMS'), `${manifest.sha256}  ${asset}\n`);
console.log(JSON.stringify({ version: metadata.version, archive: zip, size: manifest.size, sha256: manifest.sha256 }, null, 2));
