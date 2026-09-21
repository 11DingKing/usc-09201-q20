import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../src/store.mjs';
import { defaultConfig } from '../src/config.mjs';
import { auditPrivacy, hashGroupToken } from '../src/privacy.mjs';

test('隐私审计能发现手机号与证件号', () => {
  const store = createStore();
  store.notifications.push({ notice_id: 'ntf_1', message: '请联系 13812345678 协调分流' });
  store.stayReports.set('r1', { report_id: 'r1', guest_name: '张三' });
  const result = auditPrivacy(store);
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((v) => v.kind).sort(), ['forbidden_field', 'phone']);
});

test('干净的存储通过隐私审计', () => {
  const store = createStore();
  store.notifications.push({ notice_id: 'ntf_1', message: '云杉谷进入预警等级' });
  const result = auditPrivacy(store);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('团体凭证按日加盐哈希，不保存原文且跨日不可关联', () => {
  const config = defaultConfig({ tokenSalt: 's' });
  const day1 = hashGroupToken(config, '2026-09-26', 'GRP-001');
  const day2 = hashGroupToken(config, '2026-09-27', 'GRP-001');
  assert.equal(day1, hashGroupToken(config, '2026-09-26', 'GRP-001'));
  assert.notEqual(day1, day2);
  assert.equal(day1.includes('GRP-001'), false);
  assert.match(day1, /^[0-9a-f]{64}$/);
});
