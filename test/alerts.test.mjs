import assert from 'node:assert/strict';
import test from 'node:test';
import { setup } from './ingest.test.mjs';

const iso = (ms) => new Date(ms).toISOString();

// 溪流源基础阈值 500，用入口计数驱动完整告警生命周期
function drive(engine, now, id, entered, exited) {
  return engine.ingestEntrance({ batch_id: id, counter_id: 'c-creek', entered, exited, occurred_at: iso(now()) });
}

test('告警发布-升级-降级-解除全流程且每步仅通知一次', () => {
  const { engine, store, advance, now } = setup();
  drive(engine, now, 'b1', 380, 0); // 0.76 -> 关注
  drive(engine, now, 'b2', 70, 0); // 0.90 -> 预警
  drive(engine, now, 'b3', 60, 0); // 1.02 -> 管制
  drive(engine, now, 'b4', 0, 30); // 0.96 滞回带内，保持管制
  advance(11 * 60_000);
  drive(engine, now, 'b5', 0, 30); // 0.90 -> 预警
  advance(11 * 60_000);
  drive(engine, now, 'b6', 0, 120); // 0.66 -> 解除

  const types = store.notifications.map((n) => n.type);
  assert.deepEqual(types, ['issued', 'escalated', 'escalated', 'downgraded', 'resolved']);
  assert.deepEqual(store.notifications.map((n) => n.to_level), [1, 2, 3, 2, 0]);
  assert.equal(store.notifications.filter((n) => n.type === 'resolved').length, 1);
});

test('比率在阈值附近反复小幅波动不产生重复通知', () => {
  const { engine, store, advance, now } = setup();
  drive(engine, now, 'up', 380, 0); // 0.76 -> 关注（通知一次）
  for (let i = 0; i < 5; i += 1) {
    advance(60_000);
    drive(engine, now, `out-${i}`, 0, 10); // 0.74 滞回带内
    advance(60_000);
    drive(engine, now, `in-${i}`, 10, 0); // 0.76
  }
  assert.equal(store.notifications.length, 1);
  advance(11 * 60_000);
  drive(engine, now, 'final-exit', 0, 40); // 0.66 -> 解除
  assert.equal(store.notifications.length, 2);
  assert.equal(store.notifications[1].type, 'resolved');
});

test('降级在最短驻留时间前被抑制', () => {
  const { engine, store, advance, now } = setup();
  drive(engine, now, 'b1', 500, 0); // 1.00 -> 管制
  advance(60_000); // 不足默认 10 分钟驻留
  drive(engine, now, 'b2', 0, 200); // 0.60 已低于退出线，但驻留未满
  const state = store.zoneState.get('z-creek');
  assert.equal(state.level, 3);
  assert.equal(state.pending, 0);
  assert.equal(store.notifications.filter((n) => n.type === 'resolved').length, 0);
  advance(10 * 60_000); // 驻留期满，惰性重估完成解除
  const pressure = engine.zonePressure('z-creek');
  assert.equal(pressure.level, 0);
  assert.equal(store.notifications.filter((n) => n.type === 'resolved').length, 1);
});
