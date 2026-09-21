import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngine } from '../src/engine.mjs';

const DAY = '2026-09-26';
const T = (h, m = 0) =>
  Date.parse(`${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);

/** 关闭预测（visitRate 0）的小场景：验证告警、建议、提示、降级与设备离线。 */
function makeEngine() {
  const engine = createEngine({ visitRate: 0 });
  engine.registerZone({ id: 'Z1', name: '一区', baseCapacity: 100, tags: [] });
  engine.registerZone({ id: 'Z2', name: '二区', baseCapacity: 100, tags: [] });
  engine.registerSite({ id: 'S2', zoneId: 'Z2', kind: 'trail', name: '二线', baseCapacity: 50 });
  engine.registerOperator({ id: 'H1', zoneId: 'Z1', name: '甲客栈' });
  engine.registerOperator({ id: 'H2', zoneId: 'Z2', name: '乙客栈' });
  engine.registerDevice({ id: 'D1', zoneId: 'Z1', kind: 'entrance', expectedIntervalSec: 900, registeredAt: T(8) });
  return engine;
}

test('告警随等级开启/升级/解除，建议冷却期内不重复发布', () => {
  const engine = makeEngine();
  engine.ingestFlows([{ eventId: 'f1', deviceId: 'D1', windowStart: T(8), windowEnd: T(8, 15), entries: 90, exits: 0 }]);
  engine.evaluate(T(8, 15)); // 0.9 → 挂起预警
  assert.equal(engine.levelOf('Z1'), 0);
  engine.evaluate(T(8, 30)); // 连续确认 → 预警
  assert.equal(engine.levelOf('Z1'), 2);

  // 阈值临时下调 → 实测超载 → 快速升限流
  engine.ingestOverrides([{ eventId: 'ov', targetType: 'zone', targetId: 'Z1', factor: 0.5, startsAt: T(8, 30), endsAt: T(10), reason: '降雨' }]);
  engine.evaluate(T(8, 45));
  assert.equal(engine.levelOf('Z1'), 3);

  // 建议：预警、限流各一条；限流建议含替代分区 Z2
  const advisories = engine.listAdvisories('Z1');
  assert.equal(advisories.length, 2);
  assert.deepEqual(advisories.map((a) => a.level), [2, 3]);
  assert.deepEqual(advisories[1].alternatives.map((a) => a.zoneId), ['Z2']);

  // 经营者提示：本区限流指令，替代区收到分流准备
  assert.ok(engine.promptsFor('H1').some((p) => p.kind === 'restriction'));
  assert.ok(engine.promptsFor('H2').some((p) => p.kind === 'diversion_incoming'));

  // 客流回落 + 阈值到期 → 连续确认后解除
  engine.ingestFlows([{ eventId: 'f2', deviceId: 'D1', windowStart: T(8, 15), windowEnd: T(8, 30), entries: 0, exits: 50 }]);
  engine.evaluate(T(9)); // 40/50 = 0.8 → 挂起预警
  engine.evaluate(T(9, 15)); // 确认退回预警
  assert.equal(engine.levelOf('Z1'), 2);
  engine.evaluate(T(10, 15)); // 阈值到期 40/100 → 挂起正常
  engine.evaluate(T(10, 30)); // 确认解除
  assert.equal(engine.levelOf('Z1'), 0);

  const alerts = engine.listAlerts();
  assert.equal(alerts.length, 1); // 全程只有一条告警
  assert.deepEqual(alerts[0].history.map((h) => h.level), [2, 3, 2]);
  assert.equal(alerts[0].resolvedAt, T(10, 30));
  assert.equal(engine.promptsFor('H1').length, 0); // 解除后提示清空
  assert.ok(engine.listAdvisories('Z1').every((a) => a.resolvedAt != null));

  // 设备长时间未上报 → 离线降级标记
  const summary = engine.evaluate(T(12)).find((s) => s.zoneId === 'Z1');
  assert.equal(summary.degraded, true);
  assert.deepEqual(summary.offlineDevices, ['D1']);
});

test('重复事件判重，在园人数不变', () => {
  const engine = makeEngine();
  const event = { eventId: 'f1', deviceId: 'D1', windowStart: T(8), windowEnd: T(8, 15), entries: 30, exits: 0 };
  assert.equal(engine.ingestFlows([event]).applied, 1);
  const retry = engine.ingestFlows([event]);
  assert.equal(retry.applied, 0);
  assert.deepEqual(retry.duplicates, ['f1']);
  assert.equal(engine.visitorsNow('Z1', T(9)), 30);
});

test('未知设备/分区等引用错误进入 rejected，不影响整批', () => {
  const engine = makeEngine();
  const result = engine.ingestFlows([
    { eventId: 'f1', deviceId: 'NOPE', windowStart: T(8), windowEnd: T(8, 15), entries: 1, exits: 0 },
    { eventId: 'f2', deviceId: 'D1', windowStart: T(8), windowEnd: T(8, 15), entries: 2, exits: 0 },
  ]);
  assert.equal(result.applied, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'unknown_device');
});

test('未注册经营者提示返回 404 语义', () => {
  const engine = makeEngine();
  assert.throws(() => engine.promptsFor('NOPE'), (err) => err.status === 404);
});
