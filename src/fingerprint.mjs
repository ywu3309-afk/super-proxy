/**
 * 设备指纹稳定派生（derive_id）
 *
 * 移植自 workbuddy2api-hub（AGPL-3.0）的 wb_fingerprint.py，算法逐字节对齐：
 * 以账号 UID + 固定业务盐做 md5，套成 UUIDv4 形状。同一账号每次出站都来自
 * 「同一台虚拟设备」，账号之间互不关联——随机机器码反而是最明显的网关特征。
 *
 * 形态按 5.8.4 抓包对齐：machineId / sessionId 是带连字符的 UUID，
 * 请求 id 是 32 位无连字符 hex。
 */
import { randomUUID, createHash } from 'node:crypto';

/** 由 uid + salt 稳定派生一个带连字符的 UUID 形状设备标识。 */
export function deriveId(uid, salt) {
  const seed = `${salt}:${uid || 'anonymous'}`;
  let h = createHash('md5').update(seed, 'utf8').digest('hex');
  // 版本位 4 / 变体位 a：与真实客户端 machineId 的 UUIDv4 形状一致
  h = `${h.slice(0, 12)}4${h.slice(13, 16)}a${h.slice(17)}`;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** 该账号的 sessionId：官方是每进程一个 randomUUID，网关按账号派生以保持隔离。 */
export function sessionId(uid) {
  return deriveId(uid, 'session');
}

/** machineId：按账号派生，等价于「每个账号一台固定设备」。 */
export function machineId(uid) {
  return deriveId(uid, 'machine');
}

/** X-Request-ID：32 位无连字符 hex，每条请求随机（与账号无关）。 */
export function requestId() {
  return randomUUID().replace(/-/g, '');
}

/** 上报事件用的完整桌面端指纹（成长任务 / 连登 / 旅行打卡）。 */
export function desktopFingerprint(uid, nickname = '', osName = process.platform === 'win32' ? 'win32' : process.platform) {
  const now = Date.now();
  return {
    timezone: 'Asia/Shanghai',
    reportDelay: 2000,
    userId: String(uid || ''),
    username: nickname,
    userNickname: nickname,
    product: 'SaaS',
    releaseDate: 1789036585355,
    commit: '5f9692923c93033111c51ad7b003eb80204a9b75',
    ideName: 'WorkBuddy',
    ideType: 'WorkBuddy',
    ideVersion: '5.8.4',
    machineId: machineId(uid),
    sessionId: sessionId(uid),
    extName: 'workbuddy-desktop',
    extVersion: '5.8.4',
    os: osName,
    arch: 'x64',
    osVersion: '10.0.26220',
    cpuCores: 20,
    memorySize: 24,
    timestamp: now,
    presentAt: now
  };
}
