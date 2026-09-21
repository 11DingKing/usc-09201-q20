import { createHash } from 'node:crypto';

export function hashToken(salt, ...parts) {
  return createHash('sha256').update([salt, ...parts].join('|')).digest('hex');
}

export function badRequest(message, details) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'bad_request';
  error.details = details;
  return error;
}

export function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  error.code = 'not_found';
  return error;
}

export function parseTimeMs(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`${field} 必须为 ISO 8601 时间字符串`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw badRequest(`${field} 不是合法时间：${value}`);
  }
  return ms;
}

// 以景区所在时区（默认 UTC+8）划分“营业日”，在店与当日客流均按此归属
export function dayKey(ms, offsetMinutes) {
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDayKey(value, field) {
  if (typeof value !== 'string' || !DAY_KEY_RE.test(value)) {
    throw badRequest(`${field} 必须为 YYYY-MM-DD 格式`);
  }
  return value;
}

// 入报字段白名单：未约定字段一律拒绝，从源头避免个人标识混入
export function assertAllowedKeys(body, allowed) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('请求体必须为 JSON 对象');
  }
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw badRequest(`包含未约定字段：${extra.join('、')}`, { unexpected: extra });
  }
}

export function requireString(body, field) {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`${field} 必须为非空字符串`);
  }
  return value;
}

export function optionalString(body, field) {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw badRequest(`${field} 必须为字符串`);
  }
  return value;
}

export function requireInt(body, field, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = body[field];
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${field} 必须为 [${min}, ${max}] 内的整数`);
  }
  return value;
}

export function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}
