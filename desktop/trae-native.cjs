const { createServer } = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_BODY = 1024 * 1024;
const MAX_CHAT_BODY = 16 * MAX_BODY;
const MAX_IMAGE_BYTES = 4 * MAX_BODY;
const CANCEL_GRACE_MS = 15000;
const MODULE_DISCOVERY_MS = 5000;
const CDP_GRACE_MS = 5000;
// Inspector access is process-wide, including accidental duplicate bridge servers.
let operationBusy = false;
const MESSAGES = Object.freeze({
  BAD_REQUEST: '本机桥接请求格式无效', UNAUTHORIZED: '本机桥接授权无效',
  FORBIDDEN: '本机桥接拒绝此请求来源', NOT_FOUND: '本机桥接接口不存在',
  PAYLOAD_TOO_LARGE: '本机桥接请求超过大小限制', BUSY: 'TRAE 本机桥接正在处理其他请求',
  TRAE_NOT_RUNNING: '未发现唯一的官方 TRAE 主进程',
  INSPECTOR_BUSY: '本机调试端口已由其他进程或非回环监听占用',
  INSPECTOR_UNAVAILABLE: 'TRAE 本机调试连接不可用',
  INSPECTOR_CLEANUP_FAILED: 'TRAE 临时调试连接未能完成清理',
  RENDERER_BUSY: 'TRAE 窗口已有调试连接，请关闭后重试',
  WINDOW_NOT_FOUND: '未发现唯一的 TRAE 工作窗口',
  MODULE_NOT_FOUND: '未发现已加载的 TRAE 工作模块',
  TIMEOUT: 'TRAE 本机操作超时', UID_MISMATCH: 'TRAE 当前登录账号与所选账号不一致',
  STOP_FAILED: 'TRAE 停止请求未确认完成', OUTPUT_LIMIT: 'TRAE 输出达到本地限制，已请求停止',
  EVENT_LIMIT: 'TRAE 事件达到本地限制，已请求停止', TOOL_NOT_ALLOWED: 'TRAE 返回不支持的工具调用，已请求停止',
  UPSTREAM_MODEL_MISMATCH: 'TRAE 返回的模型与所选模型不一致',
  UPSTREAM_MODEL_UNCONFIRMED: 'TRAE 未返回可核验的上游模型身份',
  MODEL_UNAVAILABLE: '所选模型不在当前 TRAE 原生目录中',
  IMAGE_NOT_SUPPORTED: '当前TRAE模型未声明图片能力',
  IMAGE_UPLOAD_FAILED: '上传失败未开始模型生成',
  NATIVE_CLIENT_UNAVAILABLE: '无法访问当前 TRAE 原生客户端',
  CATALOG_UNAVAILABLE: 'TRAE 未返回可用的原生模型目录',
  INCOMPLETE_RESPONSE: 'TRAE 响应未完整结束', EMPTY_RESPONSE: 'TRAE 未返回有效文本',
  UPSTREAM_ERROR: 'TRAE 上游请求未完成，已请求停止',
  NATIVE_REQUEST_FAILED: 'TRAE 原生请求未完成', INVALID_NATIVE_RESPONSE: 'TRAE 返回了无效响应',
  NATIVE_FAILED: 'TRAE 本机操作未完成'
});
const RENDERER_CODES = Object.freeze({
  wrong_current_account: 'UID_MISMATCH', invalid_input: 'BAD_REQUEST', timeout: 'TIMEOUT',
  stop_failed: 'STOP_FAILED', output_limit: 'OUTPUT_LIMIT', event_limit: 'EVENT_LIMIT',
  tool_not_allowed: 'TOOL_NOT_ALLOWED', unsupported_tool: 'TOOL_NOT_ALLOWED',
  upstream_model_mismatch: 'UPSTREAM_MODEL_MISMATCH', model_mismatch: 'UPSTREAM_MODEL_MISMATCH',
  upstream_model_unconfirmed: 'UPSTREAM_MODEL_UNCONFIRMED',
  model_unavailable: 'MODEL_UNAVAILABLE', native_client_unavailable: 'NATIVE_CLIENT_UNAVAILABLE',
  image_not_supported: 'IMAGE_NOT_SUPPORTED', image_upload_failed: 'IMAGE_UPLOAD_FAILED',
  catalog_unavailable: 'CATALOG_UNAVAILABLE', incomplete_response: 'INCOMPLETE_RESPONSE',
  empty_response: 'EMPTY_RESPONSE', upstream_error: 'UPSTREAM_ERROR',
  native_request_failed: 'NATIVE_REQUEST_FAILED', invalid_native_response: 'INVALID_NATIVE_RESPONSE'
});

function failure(code) {
  const error = new Error(MESSAGES[code] || MESSAGES.NATIVE_FAILED);
  error.code = Object.hasOwn(MESSAGES, code) ? code : 'NATIVE_FAILED';
  return error;
}

function deadline(promise, timeoutMs, code = 'TIMEOUT') {
  let timer;
  return Promise.race([promise, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(failure(code)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

function powershell(script) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => execFile(executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' },
    (error, stdout) => {
      if (error) return reject(failure('INSPECTOR_UNAVAILABLE'));
      try { resolve(JSON.parse(stdout.trim() || '[]')); }
      catch { reject(failure('INSPECTOR_UNAVAILABLE')); }
    }));
}

function traeExecutableCandidates(env = process.env) {
  const roots = [
    env.LOCALAPPDATA,
    env.ProgramW6432,
    env.ProgramFiles,
    env['ProgramFiles(x86)']
  ].filter((value, index, values) => typeof value === 'string' && value && values.indexOf(value) === index);
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'Programs', 'Trae CN', 'Trae CN.exe'));
    candidates.push(path.join(root, 'Trae CN', 'Trae CN.exe'));
  }
  return [...new Set(candidates)];
}

function isOfficialTraeExecutable(executablePath) {
  if (typeof executablePath !== 'string' || !executablePath) return false;
  try {
    const productPath = path.join(path.dirname(executablePath), 'resources', 'app', 'product.json');
    const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
    return product && (product.nameShort === 'Trae CN' || product.applicationName === 'trae-cn' ||
      product.win32AppUserModelId === 'ByteDance.TraeCN');
  } catch {
    return false;
  }
}

async function discoverTrae() {
  if (process.platform !== 'win32') throw failure('TRAE_NOT_RUNNING');
  const expected = traeExecutableCandidates();
  if (!expected.length) throw failure('TRAE_NOT_RUNNING');
  const escaped = expected.map((value) => `'${value.replace(/'/g, "''")}'`).join(',');
  const query = (filter) => powershell(`$ErrorActionPreference='Stop'; @(
    Get-CimInstance Win32_Process | Where-Object {
      ${filter}
    } | Select-Object ProcessId, ParentProcessId, ExecutablePath,
      @{Name='HasType';Expression={ [bool]($_.CommandLine -match '--type=') }}
  ) | ConvertTo-Json -Compress`);
  let rows = await query(`$_.ExecutablePath -and @(${escaped}) -icontains $_.ExecutablePath`);
  let list = (Array.isArray(rows) ? rows : [rows]).filter((row) => isOfficialTraeExecutable(row?.ExecutablePath));
  // TRAE may be installed in a user-selected directory.  In that case the
  // product marker, not a guessed path, is the authoritative identity.
  if (!list.length) {
    rows = await query(`$_.Name -ieq 'Trae CN.exe'`);
    list = (Array.isArray(rows) ? rows : [rows]).filter((row) => isOfficialTraeExecutable(row?.ExecutablePath));
  }
  if (!list.length) throw failure('TRAE_NOT_RUNNING');
  return selectOfficialTraeRoot(list, list.map((row) => row.ExecutablePath));
}

function selectOfficialTraeRoot(rows, expected) {
  const allowed = (Array.isArray(expected) ? expected : [expected])
    .filter((value) => typeof value === 'string' && value)
    .map((value) => value.toLowerCase());
  if (!Array.isArray(rows) || !rows.length || !allowed.length) throw failure('TRAE_NOT_RUNNING');
  const byId = new Map();
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.ProcessId) || row.ProcessId < 1 ||
        !Number.isSafeInteger(row.ParentProcessId) || row.ParentProcessId < 0 ||
        typeof row.ExecutablePath !== 'string' || !allowed.includes(row.ExecutablePath.toLowerCase()) ||
        typeof row.HasType !== 'boolean' || byId.has(row.ProcessId)) throw failure('TRAE_NOT_RUNNING');
    byId.set(row.ProcessId, row);
  }
  for (const row of rows) {
    const seen = new Set([row.ProcessId]);
    let parent = row.ParentProcessId;
    while (byId.has(parent)) {
      if (seen.has(parent)) throw failure('TRAE_NOT_RUNNING');
      seen.add(parent);
      parent = byId.get(parent).ParentProcessId;
    }
  }
  const roots = rows.filter((row) => !byId.has(row.ParentProcessId));
  if (roots.length !== 1 || roots[0].HasType) throw failure('TRAE_NOT_RUNNING');
  return { pid: roots[0].ProcessId };
}

async function inspectorOwners() {
  const rows = await powershell(`$ErrorActionPreference='Stop'; @(
    Get-NetTCPConnection -LocalPort 9229 -State Listen -ErrorAction SilentlyContinue |
      Select-Object LocalAddress, OwningProcess
  ) | ConvertTo-Json -Compress`);
  return Array.isArray(rows) ? rows : [rows];
}

function ownInspector(rows, pid) {
  if (!Array.isArray(rows) || rows.some((row) => row.OwningProcess !== pid || row.LocalAddress !== '127.0.0.1')) {
    throw failure('INSPECTOR_BUSY');
  }
  return rows.length > 0;
}

async function connectInspector(deps) {
  const response = await deps.fetch('http://127.0.0.1:9229/json/list', {
    redirect: 'error', signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw failure('INSPECTOR_UNAVAILABLE');
  const text = await response.text();
  if (text.length > 65536) throw failure('INSPECTOR_UNAVAILABLE');
  const targets = JSON.parse(text);
  if (!Array.isArray(targets) || targets.length !== 1) throw failure('INSPECTOR_UNAVAILABLE');
  const target = new URL(targets[0].webSocketDebuggerUrl);
  if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1' || target.port !== '9229' ||
      target.username || target.password || !/^\/[a-f0-9-]+$/i.test(target.pathname) || target.search || target.hash) {
    throw failure('INSPECTOR_UNAVAILABLE');
  }
  if (typeof deps.WebSocket !== 'function') throw failure('INSPECTOR_UNAVAILABLE');
  const socket = new deps.WebSocket(target.href);
  const pending = new Map();
  let id = 0;
  const rejectPending = () => {
    for (const job of pending.values()) job.reject(failure('INSPECTOR_UNAVAILABLE'));
    pending.clear();
  };
  socket.addEventListener('message', ({ data }) => {
    try {
      const message = JSON.parse(data);
      const job = pending.get(message.id);
      if (!job) return;
      pending.delete(message.id);
      if (message.error) job.reject(failure('NATIVE_FAILED'));
      else job.resolve(message.result);
    } catch { rejectPending(); }
  });
  socket.addEventListener('error', rejectPending);
  socket.addEventListener('close', rejectPending);
  try {
    await deadline(new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(failure('INSPECTOR_UNAVAILABLE')), { once: true });
      socket.addEventListener('close', () => reject(failure('INSPECTOR_UNAVAILABLE')), { once: true });
    }), 5000, 'INSPECTOR_UNAVAILABLE');
  } catch (error) { socket.close(); throw error; }
  return {
    async call(method, params, timeoutMs) {
      const requestId = ++id;
      try {
        return await deadline(new Promise((resolve, reject) => {
          pending.set(requestId, { resolve, reject });
          try { socket.send(JSON.stringify({ id: requestId, method, params })); }
          catch { pending.delete(requestId); reject(failure('INSPECTOR_UNAVAILABLE')); }
        }), timeoutMs);
      } finally { pending.delete(requestId); }
    },
    close() { rejectPending(); socket.close(); }
  };
}

function operationExpression(input, performTraeOperation) {
  // All values are serialized as data, never concatenated as executable user input.
  return `(${async function (input, source, cancelGraceMs) {
    const electron = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
    const windows = electron.webContents.getAllWebContents().filter((entry) =>
      /^vscode-file:\/\/vscode-app\/.+\/(?:solo-lite|workbench)\.html(?:[?#].*)?$/.test(entry.getURL()));
    if (windows.length !== 1) return { bridgeError: 'WINDOW_NOT_FOUND' };
    const window = windows[0];
    if (window.debugger.isAttached()) return { bridgeError: 'RENDERER_BUSY' };
    let attached = false;
    const scripts = new Set();
    const listener = (event, method, params) => {
      if (method === 'Debugger.scriptParsed' &&
          /\/workbench\.desktop\.main(?:\.solo-lite-slim)?\.js(?:[?#].*)?$/.test(params.url || '')) scripts.add(params.url);
    };
    let timer;
    try {
      window.debugger.attach('1.3'); attached = true;
      window.debugger.on('message', listener);
      await Promise.race([window.debugger.sendCommand('Debugger.enable'), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 5000);
      })]);
    } catch { return { bridgeError: 'MODULE_NOT_FOUND' }; }
    finally {
      clearTimeout(timer);
      window.debugger.off('message', listener);
      if (attached && window.debugger.isAttached()) window.debugger.detach();
    }
    if (scripts.size !== 1) return { bridgeError: 'MODULE_NOT_FOUND' };
    const moduleUrl = [...scripts][0];
    const expression = '(' + source + ')(' + JSON.stringify(input) + ',' + JSON.stringify(moduleUrl) + ')';
    try {
      return await Promise.race([window.executeJavaScript(expression), new Promise((resolve, reject) => {
        // Renderer timeout may additionally await stop_chat for up to ten seconds.
        timer = setTimeout(() => reject(new Error('timeout')), input.timeoutMs + cancelGraceMs);
      })]);
    } catch { return { bridgeError: 'NATIVE_FAILED' }; }
    finally { clearTimeout(timer); }
  }.toString()})(${JSON.stringify(input)},${JSON.stringify(performTraeOperation.toString())},${CANCEL_GRACE_MS})`;
}

async function nativeOperation(input, options) {
  const deps = {
    discover: discoverTrae, owners: inspectorOwners,
    debugProcess: (pid) => process._debugProcess(pid),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetch: globalThis.fetch, WebSocket: globalThis.WebSocket,
    ...options
  };
  const target = await deps.discover();
  if (!target || !Number.isSafeInteger(target.pid) || target.pid < 1) throw failure('TRAE_NOT_RUNNING');
  let client;
  let started = false;
  try {
    const present = ownInspector(await deps.owners(), target.pid);
    if (!present) {
      // Re-read process identity immediately before opening a new inspector.
      if ((await deps.discover()).pid !== target.pid) throw failure('TRAE_NOT_RUNNING');
      await deps.debugProcess(target.pid);
      started = true;
      let ready = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        if (ownInspector(await deps.owners(), target.pid)) { ready = true; break; }
        await deps.sleep(100);
      }
      if (!ready) throw failure('INSPECTOR_UNAVAILABLE');
    }
    // Ownership is checked again before any HTTP/WS traffic to the inspector.
    if (!ownInspector(await deps.owners(), target.pid)) throw failure('INSPECTOR_UNAVAILABLE');
    client = await (deps.connectInspector || connectInspector)(deps);
    const perform = deps.performTraeOperation || require('./trae-renderer.cjs').performTraeOperation;
    if (typeof perform !== 'function') throw failure('NATIVE_FAILED');
    // Include module discovery and cancellation acknowledgement before the extra CDP margin.
    const evaluateTimeoutMs = input.timeoutMs + MODULE_DISCOVERY_MS + CANCEL_GRACE_MS + CDP_GRACE_MS;
    const result = await client.call('Runtime.evaluate', {
      expression: operationExpression(input, perform), awaitPromise: true, returnByValue: true,
      timeout: evaluateTimeoutMs
    }, evaluateTimeoutMs);
    if (result?.exceptionDetails || !result?.result || !Object.hasOwn(result.result, 'value')) throw failure('NATIVE_FAILED');
    const value = result.result.value;
    if (value?.bridgeError) throw failure(value.bridgeError);
    return value;
  } finally {
    let cleanupFailed = false;
    if (started) {
      try {
        const rows = await deps.owners();
        if (ownInspector(rows, target.pid)) {
          if (!client) client = await (deps.connectInspector || connectInspector)(deps);
          await client.call('Runtime.evaluate', {
            expression: "setTimeout(() => process.getBuiltinModule('inspector').close(), 50); true",
            returnByValue: true
          }, 3000);
        }
      } catch { cleanupFailed = true; }
    }
    try { client?.close(); } catch { cleanupFailed = true; }
    if (started && !cleanupFailed) {
      try {
        let closed = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          if (!ownInspector(await deps.owners(), target.pid)) { closed = true; break; }
          await deps.sleep(100);
        }
        cleanupFailed = !closed;
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw failure('INSPECTOR_CLEANUP_FAILED');
  }
}

// Header/container checks only; no image decoder, network request, or file access.
function imageDimensions(bytes, mediaType) {
  const bad = () => { throw failure('BAD_REQUEST'); };
  if (mediaType === 'image/png') {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) bad();
    let position = 8;
    let dimensions;
    let imageData = false;
    let ended = false;
    while (position + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(position);
      const type = bytes.toString('ascii', position + 4, position + 8);
      if (length > bytes.length - position - 12) bad();
      if (position === 8) {
        if (type !== 'IHDR' || length !== 13) bad();
        dimensions = [bytes.readUInt32BE(position + 8), bytes.readUInt32BE(position + 12)];
        const depth = bytes[position + 16], color = bytes[position + 17];
        const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!depths[color]?.includes(depth) || bytes[position + 18] !== 0 || bytes[position + 19] !== 0 || bytes[position + 20] > 1) bad();
      } else if (type === 'IHDR') bad();
      if (type === 'IDAT' && length > 0) imageData = true;
      position += length + 12;
      if (type === 'IEND') {
        if (length !== 0 || position !== bytes.length) bad();
        ended = true;
        break;
      }
    }
    if (!dimensions || !imageData || !ended) bad();
    return dimensions;
  }
  if (mediaType === 'image/jpeg') {
    if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 ||
        bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) bad();
    let position = 2;
    let dimensions;
    while (position < bytes.length - 2) {
      if (bytes[position++] !== 255) bad();
      while (bytes[position] === 255) position++;
      const marker = bytes[position++];
      if (marker === 0 || marker === 216 || marker === 217 || marker === undefined) bad();
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (position + 2 > bytes.length) bad();
      const length = bytes.readUInt16BE(position);
      if (length < 2 || position + length > bytes.length) bad();
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (dimensions || length < 11 || bytes[position + 7] < 1 || length !== 8 + 3 * bytes[position + 7]) bad();
        dimensions = [bytes.readUInt16BE(position + 5), bytes.readUInt16BE(position + 3)];
      }
      if (marker === 218) {
        if (!dimensions || position + length >= bytes.length - 2) bad();
        return dimensions;
      }
      position += length;
    }
    bad();
  }
  if (mediaType === 'image/webp') {
    if (bytes.length < 26 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
        bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) bad();
    let position = 12;
    let dimensions;
    let canvas;
    let imageData = false;
    while (position + 8 <= bytes.length) {
      const type = bytes.toString('ascii', position, position + 4);
      const length = bytes.readUInt32LE(position + 4);
      const start = position + 8;
      const end = start + length;
      if (end + (length & 1) > bytes.length) bad();
      if (type === 'VP8X') {
        if (position !== 12 || length !== 10 || canvas) bad();
        canvas = [bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1];
      } else if (type === 'VP8 ' || type === 'VP8L') {
        let current;
        if (type === 'VP8 ') {
          if (length < 10 || (bytes[start] & 1) || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))) bad();
          current = [bytes.readUInt16LE(start + 6) & 16383, bytes.readUInt16LE(start + 8) & 16383];
        } else {
          if (length < 5 || bytes[start] !== 47) bad();
          const bits = bytes.readUInt32LE(start + 1);
          if (bits >>> 29) bad();
          current = [(bits & 16383) + 1, ((bits >>> 14) & 16383) + 1];
        }
        if (dimensions) bad();
        dimensions = current;
        imageData = true;
      } else if (type === 'ANMF') {
        if (!canvas || length < 24) bad();
        const x = bytes.readUIntLE(start, 3) * 2, y = bytes.readUIntLE(start + 3, 3) * 2;
        const width = bytes.readUIntLE(start + 6, 3) + 1, height = bytes.readUIntLE(start + 9, 3) + 1;
        if (x + width > canvas[0] || y + height > canvas[1]) bad();
        imageData = true;
      }
      position = end + (length & 1);
    }
    if (position !== bytes.length || !imageData || (!canvas && !dimensions) ||
        (canvas && dimensions && (canvas[0] !== dimensions[0] || canvas[1] !== dimensions[1]))) bad();
    return canvas || dimensions;
  }
  bad();
}

function validateImages(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 4) throw failure('BAD_REQUEST');
  let total = 0;
  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    if (!image || typeof image !== 'object' || Array.isArray(image) ||
        Object.keys(image).length !== 5 || Object.keys(image).some((key) => !['id', 'mediaType', 'data', 'width', 'height'].includes(key))) throw failure('BAD_REQUEST');
    if (image.id !== `image_${index + 1}` || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mediaType) ||
        !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
        image.width < 1 || image.height < 1 || image.width > 16384 || image.height > 16384 || image.width * image.height > 40000000 ||
        typeof image.data !== 'string' || !image.data.length || image.data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) ||
        image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw failure('BAD_REQUEST');
    const bytes = Buffer.from(image.data, 'base64');
    total += bytes.length;
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || total > 8 * MAX_BODY || bytes.toString('base64') !== image.data) throw failure('BAD_REQUEST');
    const [width, height] = imageDimensions(bytes, image.mediaType);
    if (width !== image.width || height !== image.height) throw failure('BAD_REQUEST');
  }
}

function validateInput(body, operation) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => !['uid', 'model', 'prompt', 'maxChars', 'timeoutMs', ...(operation === 'chat' ? ['images'] : [])].includes(key)) ||
      typeof body.uid !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(body.uid)) {
    throw failure('BAD_REQUEST');
  }
  if (Object.hasOwn(body, 'images')) validateImages(body.images);
  if ((body.model !== undefined && (typeof body.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(body.model))) ||
      (body.prompt !== undefined && (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 65536 || body.prompt.includes('\0'))) ||
      (operation === 'chat' && (!body.model || !body.prompt)) ||
      (operation === 'catalog' && (body.model !== undefined || body.prompt !== undefined)) ||
      (body.maxChars !== undefined && (!Number.isSafeInteger(body.maxChars) || body.maxChars < 1 || body.maxChars > 65536)) ||
      (body.timeoutMs !== undefined && (!Number.isSafeInteger(body.timeoutMs) || body.timeoutMs < 1000 || body.timeoutMs > 180000))) {
    throw failure('BAD_REQUEST');
  }
  return { ...body, operation, maxChars: body.maxChars ?? 16384, timeoutMs: body.timeoutMs ?? 90000 };
}

function readBody(request, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish(failure('BAD_REQUEST')), 10000);
    const clean = () => {
      clearTimeout(timer);
      request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', error);
    };
    const finish = (error, value) => {
      clean();
      if (error) { request.resume(); reject(error); }
      else resolve(value);
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size > limit) finish(failure('PAYLOAD_TOO_LARGE'));
      else chunks.push(chunk);
    };
    const end = () => {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(failure('BAD_REQUEST')); }
    };
    const error = () => finish(failure('BAD_REQUEST'));
    request.on('data', data); request.on('end', end); request.on('error', error); request.on('aborted', error);
  });
}

function safeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('NATIVE_FAILED');
  if (value.ok === false || value.error) {
    const code = value.error?.code || value.code;
    throw failure(Object.hasOwn(RENDERER_CODES, code) ? RENDERER_CODES[code] : code);
  }
  if (Array.isArray(value.models) && value.models.some((model) => model && typeof model === 'object' &&
      Object.hasOwn(model, 'supports_vision') && typeof model.supports_vision !== 'boolean')) throw failure('INVALID_NATIVE_RESPONSE');
  const serialized = JSON.stringify(value, (key, entry) =>
    /^(?:uid|user_?id|user|token|access_?token|refresh_?token|cookie|authorization|password|secret|api_?key|private_?key|credentials?|headers?)$/i.test(key) ? undefined : entry);
  if (serialized.length > MAX_BODY) throw failure('NATIVE_FAILED');
  return JSON.parse(serialized);
}

async function createTraeBridge(options = {}) {
  const token = randomBytes(32).toString('hex');
  const expectedToken = Buffer.from(`Bearer ${token}`);
  let port;
  let closing = false;
  const respond = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', Connection: 'close' });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    let ownsBusy = false;
    try {
      if (closing || request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== undefined ||
          request.headers['sec-fetch-site'] !== undefined) throw failure('FORBIDDEN');
      const supplied = Buffer.from(request.headers.authorization || '');
      if (supplied.length !== expectedToken.length || !timingSafeEqual(supplied, expectedToken)) throw failure('UNAUTHORIZED');
      if (request.method !== 'POST' || !['/catalog', '/chat'].includes(request.url)) throw failure('NOT_FOUND');
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw failure('BAD_REQUEST');
      const bodyLimit = request.url === '/chat' ? MAX_CHAT_BODY : MAX_BODY;
      if (Number(request.headers['content-length']) > bodyLimit) throw failure('PAYLOAD_TOO_LARGE');
      if (operationBusy) throw failure('BUSY');
      const input = validateInput(await readBody(request, bodyLimit), request.url.slice(1));
      if (operationBusy) throw failure('BUSY');
      operationBusy = true; ownsBusy = true;
      const result = await (options.runOperation || ((value) => nativeOperation(value, options)))(input);
      respond(response, 200, safeResult(result));
    } catch (error) {
      const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'NATIVE_FAILED';
      const status = { BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
        PAYLOAD_TOO_LARGE: 413, BUSY: 429, TIMEOUT: 504 }[code] || 502;
      if (!response.headersSent && !response.destroyed) respond(response, status, { ok: false, error: { code, message: MESSAGES[code] } });
      request.resume();
    } finally { if (ownsBusy) operationBusy = false; }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  let closePromise;
  return {
    url: `http://127.0.0.1:${port}`, token,
    close() {
      closing = true;
      closePromise ||= new Promise((resolve, reject) => server.close((error) => error ? reject(failure('NATIVE_FAILED')) : resolve()));
      return closePromise;
    }
  };
}

module.exports = { createTraeBridge, selectOfficialTraeRoot };
