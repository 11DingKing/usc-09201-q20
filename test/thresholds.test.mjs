import assert from 'node:assert/strict';
import test from 'node:test';
import { setup } from './ingest.test.mjs';

const iso = (ms) => new Date(ms).toISOString();

test('临时下调在窗口内生效，过期自动恢复基础阈值', () => {
  const { engine, now, advance } = setup();
  engine.setThresholdOverride({
    override_id: 'ovr-1', zone_id: 'z-cloud', limit: 400,
    starts_at: iso(now()), ends_at: iso(now() + 3_600_000), reason: '演练下调',
  });
  const active = engine.zonePressure('z-cloud');
  assert.equal(active.limit.effective, 400);
  assert.equal(active.limit.overrides.length, 1);
  advance(3_600_001);
  const expired = engine.zonePressure('z-cloud');
  assert.equal(expired.limit.effective, 800);
  assert.equal(expired.limit.overrides.length, 0);
});

test('阈值临时下调可触发等级上调', () => {
  const { engine, now } = setup();
  engine.ingestStay({ report_id: 'r1', hotel_id: 'h1', zone_id: 'z-cloud', stay_date: '2026-09-26', guests: 600 });
  assert.equal(engine.zonePressure('z-cloud').level, 1); // 600/800 = 0.75 关注
  engine.setThresholdOverride({
    override_id: 'ovr-2', zone_id: 'z-cloud', limit: 600,
    starts_at: iso(now()), ends_at: iso(now() + 3_600_000), reason: '水源点保护',
  });
  assert.equal(engine.zonePressure('z-cloud').level, 3); // 600/600 = 1.0 管制
});

test('重复 override_id 幂等，非法窗口被拒绝', () => {
  const { engine, store, now } = setup();
  const body = {
    override_id: 'ovr-3', zone_id: 'z-cloud', limit: 500,
    starts_at: iso(now()), ends_at: iso(now() + 3_600_000), reason: '测试',
  };
  engine.setThresholdOverride(body);
  const version = store.version;
  const replay = engine.setThresholdOverride(body);
  assert.equal(replay.duplicated, true);
  assert.equal(store.version, version);
  assert.throws(
    () => engine.setThresholdOverride({ ...body, override_id: 'ovr-4', ends_at: iso(now() - 1000) }),
    (error) => error.status === 400,
  );
});
