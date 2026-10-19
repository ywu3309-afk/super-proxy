export function nowIso() {
  return new Date().toISOString();
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clampInt(value, min, max, fallback = min) {
  const number = Math.round(safeNumber(value, fallback));
  if (number < min) return min;
  if (number > max) return max;
  return number;
}

export function formatInTimeZone(date, timeZone, options = {}) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...options
  }).format(date);
}

export function timeZoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour === '24' ? '0' : values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

export function localDate(date = new Date(), timeZone = 'UTC') {
  const parts = timeZoneParts(date, timeZone);
  const pad = (value) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function timeZoneOffsetMs(date, timeZone) {
  const parts = timeZoneParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function zonedInstant(year, month, day, hour, minute, timeZone) {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offset = timeZoneOffsetMs(new Date(guessUtc), timeZone);
  let instant = guessUtc - offset;
  const secondOffset = timeZoneOffsetMs(new Date(instant), timeZone);
  if (secondOffset !== offset) instant = guessUtc - secondOffset;
  return instant;
}

export function nextDailyRunAt(hhmm, timeZone, from = new Date()) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  const hour = match ? clampInt(match[1], 0, 23, 9) : 9;
  const minute = match ? clampInt(match[2], 0, 59, 0) : 0;
  const parts = timeZoneParts(from, timeZone);
  let candidate = zonedInstant(parts.year, parts.month, parts.day, hour, minute, timeZone);
  if (candidate <= from.getTime()) {
    const tomorrow = new Date(candidate + 26 * 3600 * 1000);
    const nextParts = timeZoneParts(tomorrow, timeZone);
    candidate = zonedInstant(nextParts.year, nextParts.month, nextParts.day, hour, minute, timeZone);
  }
  return new Date(candidate);
}

export function backoffDelay(attempt, baseMs = 4000, maxMs = 300000) {
  const delay = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(maxMs, Math.round(delay * (0.85 + Math.random() * 0.3)));
}

export function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 8) return '•'.repeat(text.length);
  return `${text.slice(0, 4)}${'•'.repeat(Math.min(24, text.length - 8))}${text.slice(-4)}`;
}

export function pickFirst(object, paths, fallback = undefined) {
  for (const path of paths) {
    const value = readPath(object, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

export function readPath(object, path) {
  if (!path) return undefined;
  if (typeof path === 'number') return object?.[path];
  const raw = String(path);
  // 数组聚合：data.Accounts[].Remain → 对数组每一项取值后求和
  const marker = raw.indexOf('[]');
  if (marker >= 0) {
    const head = raw.slice(0, marker);
    const tail = raw.slice(marker + 2).replace(/^\./, '');
    const list = head ? readPath(object, head) : object;
    if (!Array.isArray(list)) return undefined;
    const values = list
      .map((item) => (tail ? readPath(item, tail) : item))
      .filter((value) => value !== undefined && value !== null && value !== '');
    if (!values.length) return undefined;
    if (values.every((value) => typeof value === 'number')) {
      return values.reduce((sum, value) => sum + value, 0);
    }
    return values;
  }
  const segments = raw.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = object;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

export function toNumberDeep(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9a-zA-Z.\-+/=]/g, '');
    const direct = Number(cleaned);
    if (Number.isFinite(direct) && cleaned !== '') return direct;
    const digits = value.replace(/[^0-9.\-]/g, '');
    const parsed = Number(digits);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value && typeof value === 'object') {
    if ('value' in value) return toNumberDeep(value.value);
    if ('amount' in value) return toNumberDeep(value.amount);
    if ('total' in value) return toNumberDeep(value.total);
  }
  return undefined;
}

export function normalizeId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
