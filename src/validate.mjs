/** 业务校验错误，app 层按 status 映射为 HTTP 响应。 */
export class EngineError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.status = status;
  }
}

export function requireFields(obj, fields, label) {
  const missing = fields.filter((f) => obj?.[f] === undefined || obj?.[f] === null);
  if (missing.length > 0) {
    throw new EngineError('missing_fields', `${label}缺少字段: ${missing.join(', ')}`);
  }
}

export function ensureNonNegInt(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new EngineError('invalid_field', `${field} 必须是非负整数`);
  }
}

export function ensurePositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new EngineError('invalid_field', `${field} 必须是正整数`);
  }
}

export function ensureTs(value, field) {
  const ts = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ts)) {
    throw new EngineError('invalid_field', `${field} 不是有效时间`);
  }
  return ts;
}
