function tokenize(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === '\\' && index + 1 < input.length) {
        current += input[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if (char === '\\' && index + 1 < input.length) {
      current += input[index + 1];
      index += 1;
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function parseCurl(command) {
  const text = String(command || '')
    .replace(/\\\r?\n/g, ' ')
    .replace(/\^\r?\n/g, ' ')
    .replace(/`\r?\n/g, ' ')
    .trim();
  if (!/^curl\b/i.test(text)) {
    return { ok: false, error: 'not_a_curl_command' };
  }
  const tokens = tokenize(text).slice(1);
  let method = null;
  let url = '';
  let body = null;
  const headers = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];

    if (['-X', '--request'].includes(token) && next) {
      method = String(next).toUpperCase();
      index += 1;
      continue;
    }
    if (['-H', '--header'].includes(token) && next) {
      const separator = next.indexOf(':');
      if (separator > 0) headers[next.slice(0, separator).trim()] = next.slice(separator + 1).trim();
      index += 1;
      continue;
    }
    if (['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode'].includes(token) && next) {
      body = next;
      if (!method) method = 'POST';
      index += 1;
      continue;
    }
    if (['-b', '--cookie'].includes(token) && next) {
      headers.Cookie = next;
      index += 1;
      continue;
    }
    if (['-A', '--user-agent'].includes(token) && next) {
      headers['User-Agent'] = next;
      index += 1;
      continue;
    }
    if (['--url'].includes(token) && next) {
      url = next;
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    if (!url) url = token;
  }

  if (!url) return { ok: false, error: 'no_url_found' };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }

  const origin = parsed.origin;
  const path = `${parsed.pathname}${parsed.search}`;
  let parsedBody = null;
  if (body) {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      parsedBody = body;
    }
  }

  const cookie = headers.Cookie || headers.cookie || '';
  const authorization = headers.Authorization || headers.authorization || '';
  let authType = null;
  let secret = null;
  if (cookie) {
    authType = 'cookie';
    secret = cookie;
  } else if (authorization) {
    authType = 'bearer';
    secret = authorization.replace(/^Bearer\s+/i, '');
  }

  const lowerHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowered = key.toLowerCase();
    if (['cookie', 'authorization', 'content-length', 'host', 'connection', 'content-type', 'accept-encoding'].includes(lowered)) continue;
    lowerHeaders[lowered] = value;
  }

  return {
    ok: true,
    method: method || 'GET',
    origin,
    path,
    headers: lowerHeaders,
    body: parsedBody,
    authType,
    secret,
    rawHeaders: headers
  };
}
