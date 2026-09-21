import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../src/store.mjs';
import { defaultConfig } from '../src/config.mjs';
import { createEngine } from '../src/engine.mjs';
import { seedStore } from '../src/seed.mjs';

const DAY = '2026-09-26';
const START = Date.parse('2026-09-26T08:00:00+08:00');

export function setup(startMs = START) {
  let now = startMs;
  const store = createStore();
  seedStore(store, now);
  const config = defaultConfig({ tokenSalt: 'test-salt' });
  const engine = createEngine({ store, config, clock: { nowMs: () => now } });
  return { store, engine, config, advance: (ms) => { now += ms; }, now: () => now };
}

test('相同 report_id 重复上报被幂等去重', () => {
  const { engine, store } = setup();
  const body = { report_id: 'r1', hotel_id: 'h1', zone_id: 'z-cloud', stay_date: DAY, guests: 100 };
  const first = engine.ingestStay(body);
  const version = store.version;
  const second = engine.ingestStay(body);
  assert.equal(first.duplicated, false);
  assert.equal(second.duplicated, true);
  assert.equal(store.version, version);
  assert.equal(engine.zonePressure('z-cloud').load.in_house, 100);
});

test('同酒店同住宿日新上报取代旧上报（含团体分量）', () => {
  const { engine } = setup();
  engine.ingestStay({
    report_id: 'r1', hotel_id: 'h1', zone_id: 'z-cloud', stay_date: DAY, guests: 100,
    groups: [{ token: 'G', members_at_property: 40, declared_total: 40 }],
  });
  engine.ingestStay({
    report_id: 'r2', hotel_id: 'h1', zone_id: 'z-cloud', stay_date: DAY, guests: 120,
    groups: [{ token: 'G', members_at_property: 45, declared_total: 45 }],
  });
  const pressure = engine.zonePressure('z-cloud');
  // 若旧分量未替换，团体分量 40+45 将超出申报 45 而被扣减
  assert.equal(pressure.load.in_house, 120);
  assert.equal(pressure.load.group_excess_deducted, 0);
});

test('团体拆分跨店申报超出总量时扣减并标记数据质量', () => {
  const { engine } = setup();
  engine.ingestStay({
    report_id: 'r1', hotel_id: 'h1', zone_id: 'z-cloud', stay_date: DAY, guests: 100,
    groups: [{ token: 'G', members_at_property: 60, declared_total: 90 }],
  });
  engine.ingestStay({
    report_id: 'r2', hotel_id: 'h2', zone_id: 'z-cloud', stay_date: DAY, guests: 100,
    groups: [{ token: 'G', members_at_property: 50, declared_total: 90 }],
  });
  const pressure = engine.zonePressure('z-cloud');
  // 分量合计 110 > 申报 90，超出 20 全部分摊在本区扣减
  assert.equal(pressure.load.in_house, 180);
  assert.equal(pressure.load.group_excess_deducted, 20);
  assert.equal(pressure.data_quality.group_warnings.length, 1);
  assert.equal(pressure.data_quality.degraded, true);
});

test('迟到批次计入发生日而非到达日', () => {
  const { engine } = setup(Date.parse('2026-09-27T00:30:00+08:00'));
  engine.ingestEntrance({
    batch_id: 'b-yesterday', counter_id: 'c-creek', entered: 50, exited: 0,
    occurred_at: '2026-09-26T23:50:00+08:00',
  });
  const late = engine.ingestEntrance({
    batch_id: 'b-today', counter_id: 'c-creek', entered: 30, exited: 0,
    occurred_at: '2026-09-27T00:10:00+08:00',
  });
  assert.equal(late.late, true);
  const pressure = engine.zonePressure('z-creek');
  assert.equal(pressure.load.day_visitors, 30);
  assert.equal(pressure.inputs.entrance_batches, 1);
  assert.equal(pressure.data_quality.late_batches, 1);
});

test('重复 batch_id 重试不产生重复计数', () => {
  const { engine, store } = setup();
  const body = { batch_id: 'b1', counter_id: 'c-creek', entered: 40, exited: 0, occurred_at: new Date(START).toISOString() };
  engine.ingestEntrance(body);
  const version = store.version;
  const replay = engine.ingestEntrance(body);
  assert.equal(replay.duplicated, true);
  assert.equal(store.version, version);
  assert.equal(engine.zonePressure('z-creek').load.day_visitors, 40);
});

test('设备心跳超时标记离线，恢复心跳后解除', () => {
  const { engine, advance } = setup();
  advance(4 * 60_000);
  const offline = engine.zonePressure('z-cloud');
  assert.equal(offline.data_quality.degraded, true);
  assert.deepEqual(offline.data_quality.offline_counters.sort(), ['c-cloud-n', 'c-cloud-s']);
  engine.heartbeat({ counter_id: 'c-cloud-n' });
  const recovered = engine.zonePressure('z-cloud');
  assert.deepEqual(recovered.data_quality.offline_counters, ['c-cloud-s']);
});

test('未登记设备、未来发生时间、未约定字段均被拒绝', () => {
  const { engine, now } = setup();
  assert.throws(
    () => engine.ingestEntrance({ batch_id: 'b1', counter_id: 'c-ghost', entered: 1, exited: 0, occurred_at: new Date(now()).toISOString() }),
    (error) => error.status === 404,
  );
  assert.throws(
    () => engine.ingestEntrance({ batch_id: 'b2', counter_id: 'c-creek', entered: 1, exited: 0, occurred_at: new Date(now() + 3_600_000).toISOString() }),
    (error) => error.status === 400,
  );
  assert.throws(
    () => engine.ingestStay({ report_id: 'r9', hotel_id: 'h1', zone_id: 'z-cloud', stay_date: DAY, guests: 1, guest_name: '张三' }),
    (error) => error.status === 400,
  );
});
