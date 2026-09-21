import crypto from 'node:crypto';

/**
 * 隐私边界的第一道防线：任何接入负载只要携带个人级字段即整体拒绝（HTTP 422）。
 * 系统只处理聚合计数，从设计上保证个人轨迹无法被还原。
 */
export class PrivacyError extends Error {
  constructor(paths) {
    super(`负载包含个人数据字段: ${paths.join(', ')}`);
    this.name = 'PrivacyError';
    this.code = 'person_data_rejected';
    this.status = 422;
    this.paths = paths;
  }
}

// 归一化（小写、去 _-空格）后匹配的禁止字段名。分区/经营者的 name 是机构名称，不在此列。
const FORBIDDEN_KEYS = new Set([
  'personid', 'visitorid', 'touristid', 'userid', 'openid',
  'idcard', 'idnumber', 'idno', 'passport',
  'realname', 'personname', 'guestname', 'visitorname', 'username', 'nickname',
  'phone', 'mobile', 'tel', 'email', 'address',
  'faceid', 'face', 'plate', 'carnumber',
  'trajectory', 'track', 'trace', 'location',
  'guest', 'member', 'members', 'memberlist', 'tourist',
]);

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[_\-\s]/g, '');
}

/** 深度扫描负载，返回所有命中禁止字段的路径。 */
export function findForbiddenKeys(payload, path = '') {
  const hits = [];
  if (Array.isArray(payload)) {
    payload.forEach((item, index) => hits.push(...findForbiddenKeys(item, `${path}[${index}]`)));
  } else if (payload && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      const current = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEYS.has(normalizeKey(key))) hits.push(current);
      hits.push(...findForbiddenKeys(value, current));
    }
  }
  return hits;
}

export function assertNoPersonData(payload) {
  const hits = findForbiddenKeys(payload);
  if (hits.length > 0) throw new PrivacyError(hits);
}

/**
 * 团体标识按日散列：每天一把随机盐，团体 ID 以 HMAC 形式入库。
 * 跨天无法关联同一团体，原始 ID 不落盘，从存储上切断轨迹还原的可能。
 */
export function createGroupKeyer() {
  const salts = new Map(); // dayKey -> Buffer
  return {
    keyFor(groupId, dayKey) {
      if (!salts.has(dayKey)) salts.set(dayKey, crypto.randomBytes(32));
      return crypto
        .createHmac('sha256', salts.get(dayKey))
        .update(String(groupId))
        .digest('hex')
        .slice(0, 24);
    },
    /** 日切后丢弃旧盐，历史团体键不可再被延展或关联。 */
    retainOnly(dayKey) {
      for (const key of [...salts.keys()]) {
        if (key !== dayKey) salts.delete(key);
      }
    },
  };
}

/** k-匿名：0 照常发布，0 < n < k 的小计数对外抑制，避免小团体被单独识别。 */
export function suppressSmallCount(count, k) {
  if (count > 0 && count < k) return { count: null, suppressed: true };
  return { count, suppressed: false };
}

/** 对存储快照做禁止字段扫描，供演练与 /v1/privacy/report 使用。 */
export function scanForForbiddenKeys(snapshot) {
  const violations = findForbiddenKeys(snapshot);
  return { ok: violations.length === 0, violations };
}
