/**
 * 从桌面客户端的 .info 凭据文件导入账号
 *
 * 移植自 workbuddy2api-hub（AGPL-3.0）的 wb_accounts.scan_desktop_credentials：
 * Windows 上客户端把登录态放在
 *   %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
 * （国际版是 workbuddy-desktop-ai.info）。2026-09-24 起 accessToken / refreshToken
 * 变成 $wbEncrypted 信封，需要 at-rest 密钥才能读回来。
 *
 * 与 CDP 导入的分工：客户端在跑就用 CDP（实时登录态）；客户端没跑或想批量
 * 导入就用这里的文件导入（需要先有密钥）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { cachedKey, decryptField, isEnvelope } from './atrest.mjs';

export const INFO_FILES = [
  { name: 'workbuddy-desktop-ai.info', realm: 'intl' },
  { name: 'workbuddy-desktop.info', realm: 'cn' }
];

/** 客户端凭据目录（Windows 与 macOS/Linux 的常见布局都探一遍）。 */
export function desktopAuthDirs() {
  const dirs = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    dirs.push(join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
    dirs.push(join(homedir(), '.workbuddy', 'auth'));
  } else {
    const home = homedir();
    const base = process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : join(home, '.local', 'share');
    for (const app of ['CodeBuddyExtension', 'WorkBuddy', 'CodeBuddy']) {
      dirs.push(join(base, app, 'Data', 'Public', 'auth'));
      dirs.push(join(base, app, 'auth'));
    }
  }
  return dirs;
}

/** 读一个可能加密的字段；没有密钥或解不开时 ok=false。 */
export function readField(field) {
  if (field === null || field === undefined || field === '') {
    return { ok: true, value: '', encrypted: false };
  }
  if (!isEnvelope(field)) {
    return { ok: true, value: typeof field === 'string' ? field : '', encrypted: false };
  }
  const key = cachedKey();
  if (!key) return { ok: false, value: '', encrypted: true, reason: 'key_required' };
  try {
    return { ok: true, value: decryptField(key, field, 'field'), encrypted: true };
  } catch (error) {
    return { ok: false, value: '', encrypted: true, reason: String(error?.message || error) };
  }
}

/**
 * 扫描本机的 .info 凭据，token 已就地解密（内存里没密钥时 keyRequired=true）。
 */
export function scanDesktopCredentials() {
  const out = [];
  for (const dir of desktopAuthDirs()) {
    if (!existsSync(dir)) continue;
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const { name, realm } of INFO_FILES) {
      if (!entries.includes(name)) continue;
      const path = join(dir, name);
      let raw;
      try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        out.push({ path, realm, ok: false, reason: 'unreadable' });
        continue;
      }
      const account = raw.account || raw.user || {};
      const auth = raw.auth || {};
      const token = readField(auth.accessToken || raw.accessToken);
      const refresh = readField(auth.refreshToken || raw.refreshToken);
      const nickname = readField(account.nickname);
      const encrypted = token.encrypted || refresh.encrypted || nickname.encrypted;
      out.push({
        path,
        realm,
        ok: token.ok && refresh.ok && Boolean(token.value),
        encrypted,
        keyRequired: encrypted && !cachedKey(),
        reason: token.reason || refresh.reason || null,
        account: {
          uid: String(account.uid || ''),
          nickname: nickname.value || String(account.uid || '').slice(0, 8),
          enterpriseId: String(account.enterpriseId || account.enterprise_id || ''),
          domain: String(account.domain || (auth.domain || '')),
          accessToken: token.value,
          refreshToken: refresh.value,
          expiresAt: Number(auth.expiresAt || 0) || null
        }
      });
    }
  }
  return out;
}

/** 把扫到的账号转成网关可用的会话 JSON（交给 registerWorkbuddyAccount）。 */
export function toSessionJson(item) {
  const account = item?.account || {};
  return JSON.stringify({
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    uid: account.uid,
    realm: item.realm,
    domain: account.domain || (item.realm === 'intl' ? 'www.workbuddy.ai' : 'copilot.tencent.com'),
    enterpriseId: account.enterpriseId,
    nickname: account.nickname
  });
}
