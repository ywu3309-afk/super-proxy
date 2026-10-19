// 打包 Windows 便携版：用 programmatic API，ignore 用锚定正则（匹配以 / 开头的相对路径）
// 用法：node build/package.mjs [--zip-dir <electron zip 目录>]
import { packager } from '@electron/packager';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, cp, copyFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const metadata = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('package.json version must be X.Y.Z');

const args = process.argv.slice(2);
const publishing = args.includes('--publish');
const zipIndex = args.indexOf('--zip-dir');
const zipDirArg = zipIndex >= 0 ? args[zipIndex + 1] : null;

const APP_NAME = 'WorkBuddy Gateway';
const outDir = publishing ? join(ROOT, 'release', `publish-v${metadata.version}`) : join(ROOT, 'release');
const TARGET = join(outDir, `${APP_NAME}-win32-x64`);

// 目标目录已存在时先改名而不是递归删除：既能回滚，也不会被批量删除保护拦住
let previous = null;
if (existsSync(TARGET)) {
  previous = `${TARGET}-prev-${Date.now()}`;
  await rename(TARGET, previous);
  console.log(`[package] 旧产物已改名：${previous}`);
}

const CACHE_DIRS = [
  process.env.ELECTRON_ZIP_DIR,
  zipDirArg,
  `${process.env.LOCALAPPDATA || ''}\\electron\\Cache\\41a5d68646d956d50e13830e121ea0b3d6ab378b6a0ce422aefc1ff214707879`,
  `${process.env.LOCALAPPDATA || ''}\\electron\\Cache`
].filter(Boolean);

const electronZipDir = CACHE_DIRS.find((dir) => {
  try { return existsSync(dir); } catch { return false; }
});

// 这些目录/文件不进 asar：锚定 ^/ 才匹配 electron-packager 的相对路径。
// hub/ 与 python/ 不进 asar——它们经 extraResource 物化到 resources/ 磁盘，
// Python 网关要直接读写 dashboard.html / wb_*.py / 定价表，读不了 asar。
// server.mjs / src / web / pricing 是旧 Node 网关实现，已被 hub/ 取代，仅留仓库备查。
const IGNORE = [/^\/(?!package\.json$|desktop(?:\/|$)|assets(?:\/|$))/];

// extraResource：物化到 resources/<name>/ 磁盘目录（Python 需读写文件，不放 asar）。
// python/ 是精简 CPython 运行时（build/portable_runtime.py 裁剪），缺了就用系统 Python 兜底。
const staging = join(ROOT, 'analysis', `package-v${metadata.version}-${Date.now()}`);
const appStage = join(staging, 'app');
const hubStage = join(staging, 'hub');
const buildTemp = join(ROOT, 'analysis', 'build-tmp');
await mkdir(appStage, { recursive: true });
await mkdir(buildTemp, { recursive: true });
process.env.TEMP = buildTemp;
process.env.TMP = buildTemp;
await copyFile(join(ROOT, 'package.json'), join(appStage, 'package.json'));
await cp(join(ROOT, 'desktop'), join(appStage, 'desktop'), { recursive: true });
await cp(join(ROOT, 'assets'), join(appStage, 'assets'), { recursive: true });
await mkdir(hubStage, { recursive: true });
for (const entry of await readdir(join(ROOT, 'hub'), { withFileTypes: true })) {
  if (entry.isFile() && (/^wb_[A-Za-z0-9_]+\.py$/.test(entry.name) || entry.name === 'dashboard.html')) {
    await copyFile(join(ROOT, 'hub', entry.name), join(hubStage, entry.name));
  }
}
for (const relative of ['catalog/README.txt', 'pricing/pricing.json']) {
  const source = join(ROOT, 'hub', relative);
  if (!existsSync(source)) continue;
  await mkdir(dirname(join(hubStage, relative)), { recursive: true });
  await copyFile(source, join(hubStage, relative));
}
const releaseInfo = join(staging, 'desktop-release.json');
await writeFile(releaseInfo, JSON.stringify({ version: metadata.version, repository: metadata.updateRepository }, null, 2));
const extraResource = [hubStage, releaseInfo, join(ROOT, 'licenses')];
if (existsSync(join('python', 'python.exe'))) {
  extraResource.push('python');
} else {
  if (publishing) throw new Error('Desktop update releases require the bundled Python runtime');
  console.log('[package] 未找到 python/python.exe，跳过自带运行时（将回退系统 Python）');
}

const started = Date.now();
const out = await packager({
  dir: appStage,
  name: 'WorkBuddy Gateway',
  platform: 'win32',
  arch: 'x64',
  out: outDir,
  overwrite: false,
  prune: false,
  electronVersion: JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
  tmpdir: buildTemp,
  asar: true,
  icon: 'assets/icon.ico',
  appVersion: metadata.version,
  win32metadata: { CompanyName: 'SuperProxy', ProductName: '超级反代', FileDescription: '超级反代 WorkBuddy Gateway', OriginalFilename: 'WorkBuddy Gateway.exe' },
  appCopyright: 'WorkBuddy Gateway',
  ...(electronZipDir ? { electronZipDir } : {}),
  download: { cacheRoot: join(ROOT, 'analysis', 'electron-download-cache') },
  ignore: IGNORE,
  extraResource
});

console.log(`[package] electron zip dir: ${electronZipDir || '(自动下载)'}`);

// 账密在 exe 同级 data/ 里（便携版的全部状态），重打包时原样搬过来，
// 否则每次更新都要重新扫码 / 重新导入。
if (previous && !publishing) {
  for (const name of ['data', 'electron-user-data']) {
    const from = join(previous, name);
    const to = join(TARGET, name);
    if (!existsSync(from)) continue;
    if (existsSync(to)) continue;
    await cp(from, to, { recursive: true });
    console.log(`[package] 已接续旧状态：${name}/`);
  }
}

console.log(`[package] 输出：${out.map((item) => resolve(item)).join(', ')}`);
console.log(`[package] 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
