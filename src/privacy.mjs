import { hashToken } from './util.mjs';

// 团体凭证只以“盐 + 住宿日”哈希落库：当日可用于拆分去重，跨日不可关联，
// 原始凭证不保存，个人与团体的行动轨迹无法被还原。
export function hashGroupToken(config, stayDay, token) {
  return hashToken(config.tokenSalt, 'group', stayDay, String(token));
}

// 个人标识字段黑名单：分区/步道的 name 属于公共参考数据，不在此列
const FORBIDDEN_KEYS = new Set([
  'guest_name', 'visitor_name', 'real_name', 'id_card', 'idcard', 'id_number', 'identity', 'passport',
  'phone', 'mobile', 'tel', 'email', 'face', 'fingerprint', 'plate', 'car_plate',
  'openid', 'open_id', 'wechat', 'wx', 'imei', 'mac',
]);

const PATTERNS = [
  { kind: 'phone', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { kind: 'id_card', re: /(?<!\d)\d{17}[\dXx](?!\d)/ },
];

// 隐私审计：扫描全部已存记录，发现个人标识字段或证件号/手机号即报告违规。
// 供管理方例行检查与演练验收“个人轨迹不得被还原”的边界。
export function auditPrivacy(store) {
  const violations = [];
  const scan = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => scan(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
          violations.push({ path: `${path}.${key}`, kind: 'forbidden_field' });
        }
        scan(item, `${path}.${key}`);
      }
      return;
    }
    if (typeof value === 'string') {
      for (const pattern of PATTERNS) {
        if (pattern.re.test(value)) violations.push({ path, kind: pattern.kind });
      }
    }
  };
  const collections = [
    'zones', 'trails', 'counters', 'stayReports', 'groupPortions',
    'entranceBatches', 'thresholdOverrides', 'notifications', 'audit',
  ];
  for (const name of collections) {
    const container = store[name];
    const entries = container instanceof Map ? [...container.entries()] : container.map((v, i) => [i, v]);
    for (const [key, value] of entries) scan(value, `${name}.${String(key)}`);
  }
  return { ok: violations.length === 0, violations };
}
