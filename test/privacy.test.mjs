import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PrivacyError,
  assertNoPersonData,
  createGroupKeyer,
  findForbiddenKeys,
  scanForForbiddenKeys,
  suppressSmallCount,
} from '../src/privacy.mjs';

test('嵌套负载中的个人字段被逐层找出', () => {
  const payload = {
    reports: [{ operatorId: 'H1', guest: { guestName: '张三', mobile: '138' } }],
    meta: { trajectory: [] },
  };
  const hits = findForbiddenKeys(payload);
  assert.ok(hits.includes('reports[0].guest.guestName'));
  assert.ok(hits.includes('reports[0].guest.mobile'));
  assert.ok(hits.includes('reports[0].guest'));
  assert.ok(hits.includes('meta.trajectory'));
});

test('携带个人数据的负载整体拒绝（422）', () => {
  assert.throws(() => assertNoPersonData({ inHouse: 5, guestName: '张三' }), (err) => {
    assert.ok(err instanceof PrivacyError);
    assert.equal(err.status, 422);
    assert.equal(err.code, 'person_data_rejected');
    return true;
  });
  assert.doesNotThrow(() => assertNoPersonData({ inHouse: 5, operatorId: 'H1' }));
});

test('k-匿名：小计数抑制，0 与大计数正常发布', () => {
  assert.deepEqual(suppressSmallCount(3, 5), { count: null, suppressed: true });
  assert.deepEqual(suppressSmallCount(5, 5), { count: 5, suppressed: false });
  assert.deepEqual(suppressSmallCount(0, 5), { count: 0, suppressed: false });
});

test('团体标识按日散列：当日稳定、跨日不可关联、旧盐丢弃后不可延展', () => {
  const keyer = createGroupKeyer();
  const k1 = keyer.keyFor('GRP-1', '2026-09-26');
  assert.equal(k1, keyer.keyFor('GRP-1', '2026-09-26')); // 当日稳定（对账需要）
  const k2 = keyer.keyFor('GRP-1', '2026-09-27');
  assert.notEqual(k1, k2); // 跨日不可关联
  keyer.retainOnly('2026-09-27');
  const k1b = keyer.keyFor('GRP-1', '2026-09-26');
  assert.notEqual(k1, k1b); // 旧盐已丢弃，历史键不可再延展
});

test('存储快照扫描：干净快照通过，混入个人字段即报告', () => {
  assert.equal(scanForForbiddenKeys({ flows: [{ entries: 3 }] }).ok, true);
  const report = scanForForbiddenKeys({ flows: [{ entries: 3, visitorId: 'x' }] });
  assert.equal(report.ok, false);
  assert.ok(report.violations.length > 0);
});
