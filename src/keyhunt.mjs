/**
 * 从运行中的桌面客户端进程内存里回收 at-rest 密钥（只读）
 *
 * 移植自 workbuddy2api-hub（AGPL-3.0）的 wb_atrest.hunt_key 思路：客户端把
 * atRestSecretKey 当成 44 字符规范 base64 传参，它在内存里就是一段孤立的
 * base64 token。因此先用正则把候选捞出来，再逐个用 keyblob 的 GCM 解封校验，
 * 验得过才是真密钥——概率上几乎不可能误伤。
 *
 * 实现放在 PowerShell + C#（VirtualQueryEx / ReadProcessMemory），因为 Node
 * 侧没有内置的进程内存读取能力，本项目也不带原生依赖。全程只读：只调用
 * OpenProcess(PROCESS_VM_READ) 与 ReadProcessMemory，不向客户端写任何东西。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { adoptKey, hasKey } from './atrest.mjs';

const SCRIPT_URL = new URL('./keyhunt.ps1', import.meta.url);
const CANDIDATE_RE = /^[A-Za-z0-9+/]{43}=$/;
const CLIENT_NAMES = ['WorkBuddy', 'WorkBuddyAI', 'CodeBuddy'];

/**
 * 打包后本模块住在 app.asar 里，而 PowerShell 打不开 asar 内的虚拟路径
 * （`-File ...\app.asar\src\keyhunt.ps1` 会直接报找不到文件）。所以脚本一旦
 * 不在真实磁盘上，就把内容物化到临时目录再执行；Electron 的 fs 能读 asar，
 * 读内容这一步在打包前后都成立。
 */
let materializedPath = null;

/** 测试用：模拟「脚本住在 app.asar 里」，强制走物化分支。 */
const FORCE_MATERIALIZE = process.env.WB_KEYHUNT_FORCE_MATERIALIZE === '1';

function scriptSource() {
  return readFileSync(fileURLToPath(SCRIPT_URL), 'utf8');
}

/**
 * 解析出「PowerShell 真的能打开」的脚本路径。
 * force=true 时无条件走物化分支（测试用；也是 app.asar 场景的保底行为）。
 */
export function resolveScript({ force = FORCE_MATERIALIZE } = {}) {
  const direct = fileURLToPath(SCRIPT_URL);
  if (!force && !direct.includes('.asar') && existsSync(direct)) return direct;
  if (materializedPath && existsSync(materializedPath)) return materializedPath;
  const text = scriptSource();
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
  const dir = join(tmpdir(), 'wb-gateway-keyhunt');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `keyhunt-${digest}.ps1`);
  writeFileSync(target, text, 'utf8');
  materializedPath = target;
  return target;
}

function scriptPath() {
  return resolveScript();
}

function runPowershell(args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath(), ...args
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error(`回收超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 PowerShell：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** 解析脚本输出：候选密钥、耗时、扫描量。 */
export function parseScanOutput(stdout) {
  const candidates = [];
  let scannedMs = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith('SCANNED_MS=')) { scannedMs = Number(text.slice(11)) || null; continue; }
    if (text.startsWith('COUNT=')) continue;
    if (CANDIDATE_RE.test(text)) candidates.push(text);
  }
  return { candidates, scannedMs };
}

/**
 * 在运行中的客户端进程里找密钥；找到就登记进内存并返回 keyId。
 * 未找到时返回 { ok:false, reason:'not_found' }，不会留下任何副作用。
 */
export async function recoverKey({ processName = null, timeoutMs = 180000, maxCandidates = 4000 } = {}) {
  const names = processName ? [processName] : CLIENT_NAMES;
  let lastError = null;
  for (const name of names) {
    let result;
    try {
      result = await runPowershell(['-ProcessName', name, '-MaxCandidates', String(maxCandidates), '-MaxBytes', '4294967296'], { timeoutMs });
    } catch (error) {
      lastError = error;
      continue;
    }
    const { candidates, scannedMs } = parseScanOutput(result.stdout);
    if (!candidates.length) {
      lastError = new Error(result.stderr.trim() || `进程 ${name} 里没找到候选密钥（可能没在运行或权限不足）`);
      continue;
    }
    for (const candidate of candidates) {
      try {
        const adopted = adoptKey(candidate);
        return { ok: true, process: name, keyId: adopted.keyId, candidates: candidates.length, scannedMs };
      } catch { /* 这把不对，换下一把 */ }
    }
    lastError = new Error(`扫到 ${candidates.length} 个候选，但都对不上 keyblob 的 protectorKeyId`);
  }
  return { ok: false, reason: lastError ? String(lastError.message) : 'not_found' };
}

export function status() {
  return { hasKey: hasKey(), script: scriptPath() };
}

/** 测试用：把候选写进临时文件（避免命令行过长）。 */
export function writeCandidates(candidates) {
  const path = join(tmpdir(), `wb-key-candidates-${process.pid}.txt`);
  writeFileSync(path, candidates.join('\n'), 'utf8');
  return path;
}

export function dropFile(path) {
  try { unlinkSync(path); } catch { /* ignore */ }
}

export function readScript() {
  return readFileSync(scriptPath(), 'utf8');
}
