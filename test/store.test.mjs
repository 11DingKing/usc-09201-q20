import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfig } from '../src/config.mjs';
import {
  activeOverrideFactor,
  applyFlow,
  applyGroupArrival,
  applyGroupBooking,
  applyOccupancy,
  applyOverride,
  createStore,
  hasSeen,
  inHouseTotal,
  markSeen,
  visitorsNow,
} from '../src/store.mjs';

const DAY = '2026-09-26';
const T = (h, m = 0) =>
  Date.parse(`${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);

function makeStore() {
  return createStore(createConfig());
}

test('事件按 eventId 幂等去重', () => {
  const store = makeStore();
  assert.equal(hasSeen(store, 'e1'), false);
  markSeen(store, 'e1');
  assert.equal(hasSeen(store, 'e1'), true);
});

test('迟到窗口按发生时段计入，未结束窗口不计入', () => {
  const store = makeStore();
  applyFlow(store, { eventId: 'f1', deviceId: 'D', zoneId: 'Z', siteId: null, windowStart: T(9), windowEnd: T(9, 15), entries: 10, exits: 0 });
  assert.equal(visitorsNow(store, 'Z', T(9, 10)), 0); // 窗口未结束
  assert.equal(visitorsNow(store, 'Z', T(9, 15)), 10); // 迟到补报仍归入发生时段
  applyFlow(store, { eventId: 'f2', deviceId: 'D', zoneId: 'Z', siteId: null, windowStart: T(9, 15), windowEnd: T(9, 30), entries: 5, exits: 8 });
  assert.equal(visitorsNow(store, 'Z', T(10)), 7);
});

test('点位流量不与分区入口流量混算', () => {
  const store = makeStore();
  applyFlow(store, { eventId: 'f1', deviceId: 'D', zoneId: 'Z', siteId: 'S1', windowStart: T(9), windowEnd: T(9, 15), entries: 3, exits: 0 });
  assert.equal(visitorsNow(store, 'Z', T(10)), 0);
});

test('在店上报最新者为准，跨日陈旧上报不计入', () => {
  const store = makeStore();
  store.operators.set('H1', { id: 'H1', zoneId: 'Z', name: '甲' });
  applyOccupancy(store, { eventId: 'o1', operatorId: 'H1', inHouse: 50, occurredAt: T(8) });
  applyOccupancy(store, { eventId: 'o2', operatorId: 'H1', inHouse: 40, occurredAt: T(9) });
  applyOccupancy(store, { eventId: 'o3', operatorId: 'H1', inHouse: 999, occurredAt: T(7) }); // 乱序旧数据
  assert.equal(inHouseTotal(store, 'Z', T(10)), 40);
  assert.equal(inHouseTotal(store, 'Z', T(10) + 24 * 3600e3), 0); // 次日不计前日
});

test('阈值调整取生效窗口内最严格系数，到期自动恢复', () => {
  const store = makeStore();
  applyOverride(store, { id: 'ov1', targetType: 'zone', targetId: 'Z', factor: 0.75, startsAt: T(10), endsAt: T(16) });
  applyOverride(store, { id: 'ov2', targetType: 'zone', targetId: 'Z', factor: 0.5, startsAt: T(11), endsAt: T(12) });
  assert.equal(activeOverrideFactor(store, 'zone', 'Z', T(9)), 1);
  assert.equal(activeOverrideFactor(store, 'zone', 'Z', T(10, 30)), 0.75);
  assert.equal(activeOverrideFactor(store, 'zone', 'Z', T(11, 30)), 0.5);
  assert.equal(activeOverrideFactor(store, 'zone', 'Z', T(13)), 0.75);
  assert.equal(activeOverrideFactor(store, 'zone', 'Z', T(16)), 1);
});

test('团体拆分对账：整团与分批取较大者，分批判重，超预约记异常', () => {
  const store = makeStore();
  applyGroupBooking(store, 'key1', { zoneId: 'Z', day: DAY, expectedSize: 60 });
  applyGroupArrival(store, 'key1', { zoneId: 'Z', day: DAY, kind: 'whole', count: 60, occurredAt: T(11), eventId: 'a1' });
  assert.equal(visitorsNow(store, 'Z', T(12)), 60);
  // 拆分三批进入：与整团上报并存时仍只计 60
  applyGroupArrival(store, 'key1', { zoneId: 'Z', day: DAY, kind: 'part', partId: 'p1', count: 20, occurredAt: T(11, 5), eventId: 'a2' });
  applyGroupArrival(store, 'key1', { zoneId: 'Z', day: DAY, kind: 'part', partId: 'p2', count: 20, occurredAt: T(11, 10), eventId: 'a3' });
  applyGroupArrival(store, 'key1', { zoneId: 'Z', day: DAY, kind: 'part', partId: 'p3', count: 20, occurredAt: T(11, 15), eventId: 'a4' });
  assert.equal(visitorsNow(store, 'Z', T(12)), 60);
  // 同一分批重复上报（不同 eventId）判重
  const outcome = applyGroupArrival(store, 'key1', { zoneId: 'Z', day: DAY, kind: 'part', partId: 'p1', count: 20, occurredAt: T(11, 5), eventId: 'a5' });
  assert.equal(outcome, 'duplicate_part');
  assert.equal(visitorsNow(store, 'Z', T(12)), 60);
  // 分批合计超过预约规模：按实际计入并记异常
  applyGroupArrival(store, 'key1', { zoneId: 'Z', day: DAY, kind: 'part', partId: 'p4', count: 25, occurredAt: T(11, 20), eventId: 'a6' });
  assert.equal(visitorsNow(store, 'Z', T(12)), 85);
  assert.ok(store.anomalies.some((a) => a.type === 'over_expected'));
});

test('未预约团体按异常记录但正常计数', () => {
  const store = makeStore();
  applyGroupArrival(store, 'key-x', { zoneId: 'Z', day: DAY, kind: 'whole', count: 15, occurredAt: T(11), eventId: 'a1' });
  assert.equal(visitorsNow(store, 'Z', T(12)), 15);
  assert.ok(store.anomalies.some((a) => a.type === 'unbooked_group'));
});
