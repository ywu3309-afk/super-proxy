// 极简 asar 读取器：列出目录 / 抽取单文件 / 全文搜索，零依赖
// 用法：
//   node build/asar.mjs list  <app.asar> [前缀]
//   node build/asar.mjs cat   <app.asar> <内部路径> [输出文件]
//   node build/asar.mjs grep  <app.asar> <正则> [--max=200]
import { open, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const [mode, archive, arg1, arg2] = process.argv.slice(2);
if (!mode || !archive) {
  console.error('usage: asar.mjs <list|cat|grep> <app.asar> [arg]');
  process.exit(1);
}

const handle = await open(archive, 'r');
const { size } = await handle.stat();

// asar: [uint32 4][uint32 headerPickleSize][uint32 4][uint32 jsonLen][json...][files...]
const head = Buffer.alloc(16);
await handle.read(head, 0, 16, 0);
const headerPickleSize = head.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerPickleSize);
await handle.read(headerBuf, 0, headerPickleSize, 8);
const jsonLen = headerBuf.readUInt32LE(4);
const headerJson = JSON.parse(headerBuf.slice(8, 8 + jsonLen).toString('utf8'));
const baseOffset = 8 + headerPickleSize;

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, full, out);
    else out.push({ path: full, size: Number(entry.size || 0), offset: Number(entry.offset || 0), unpacked: Boolean(entry.unpacked) });
  }
  return out;
}

const files = walk(headerJson, '', []);

async function readFile(entry) {
  if (entry.unpacked) {
    const { readFile: rf } = await import('node:fs/promises');
    return rf(`${archive}.unpacked/${entry.path}`);
  }
  const buffer = Buffer.alloc(entry.size);
  await handle.read(buffer, 0, entry.size, baseOffset + entry.offset);
  return buffer;
}

if (mode === 'list') {
  const prefix = arg1 || '';
  const rows = files.filter((f) => f.path.startsWith(prefix));
  for (const row of rows.sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(`${String(row.size).padStart(10)}  ${row.path}${row.unpacked ? '  [unpacked]' : ''}`);
  }
  console.log(`--- ${rows.length} / ${files.length} entries, archive ${(size / 1048576).toFixed(1)} MB`);
} else if (mode === 'cat') {
  const entry = files.find((f) => f.path === arg1);
  if (!entry) { console.error('not found:', arg1); process.exit(2); }
  const buffer = await readFile(entry);
  if (arg2) {
    await mkdir(dirname(arg2), { recursive: true });
    await writeFile(arg2, buffer);
    console.log(`wrote ${arg2} (${buffer.length} bytes)`);
  } else {
    process.stdout.write(buffer);
  }
} else if (mode === 'grep') {
  const re = new RegExp(arg1, 'i');
  const maxArg = process.argv.find((item) => item.startsWith('--max='));
  const max = maxArg ? Number(maxArg.split('=')[1]) : 200;
  const exts = /\.(js|mjs|cjs|json|ts|html|css|txt|md|yml|yaml)$/i;
  let hits = 0;
  for (const entry of files) {
    if (!exts.test(entry.path)) continue;
    if (entry.size > 40 * 1048576) continue;
    let buffer;
    try { buffer = await readFile(entry); } catch { continue; }
    const text = buffer.toString('utf8');
    if (!re.test(text)) continue;
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (hits >= max) return;
      if (!re.test(line)) return;
      hits += 1;
      console.log(`${entry.path}:${index + 1}: ${line.trim().slice(0, 260)}`);
    });
    if (hits >= max) break;
  }
  console.log(`--- hits ${hits} (limit ${max})`);
}
await handle.close();
