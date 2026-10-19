// 用本机 Chrome 无头截图（不装 puppeteer）
// 用法：node build/shoot.mjs <url> <输出png> [宽x高] [虚拟时间ms]
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';

const [rawUrl, rawOut, size = '1440x1000', budget = '4000'] = process.argv.slice(2);
if (!rawUrl || !rawOut) {
  console.error('usage: node build/shoot.mjs <url> <out.png> [宽x高] [ms]');
  process.exit(1);
}
const url = rawUrl;
const out = resolve(rawOut);
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => existsSync(p));
if (!CHROME) throw new Error('没找到 Chrome/Edge');

await mkdir(dirname(out), { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'wb-shot-'));
const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--hide-scrollbars',
  '--no-proxy-server',
  '--no-first-run',
  '--no-default-browser-check',
  '--force-device-scale-factor=1',
  `--user-data-dir=${profile}`,
  `--window-size=${size.replace('x', ',')}`,
  `--virtual-time-budget=${budget}`,
  `--screenshot=${out}`,
  url
];

await new Promise((resolve, reject) => {
  const child = spawn(CHROME, args, { stdio: 'ignore' });
  const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 45000);
  child.on('error', reject);
  child.on('close', () => { clearTimeout(timer); resolve(); });
});
await rm(profile, { recursive: true, force: true }).catch(() => {});
if (!existsSync(out)) throw new Error('截图没生成');
console.log(`${out}  ${size}`);
