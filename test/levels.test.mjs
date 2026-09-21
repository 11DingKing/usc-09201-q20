import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateLevel } from '../src/levels.mjs';
import { defaultConfig } from '../src/config.mjs';

const config = defaultConfig({ minDwellMs: 600_000 });

test('比率上升可跨级立即升级', () => {
  const result = evaluateLevel({ ratio: 1.05, current: 0, lastChangeMs: 0, nowMs: 1000, config });
  assert.equal(result.level, 3);
  assert.equal(result.changed, true);
});

test('比率在滞回带内保持当前等级', () => {
  // 当前预警(2)，比率 0.87 仍高于退出线 0.85，不降级
  const result = evaluateLevel({ ratio: 0.87, current: 2, lastChangeMs: 0, nowMs: 10_000_000, config });
  assert.equal(result.level, 2);
  assert.equal(result.changed, false);
});

test('降级需满足最短驻留时间', () => {
  const blocked = evaluateLevel({ ratio: 0.5, current: 2, lastChangeMs: 1000, nowMs: 1000 + 60_000, config });
  assert.equal(blocked.level, 2);
  assert.equal(blocked.changed, false);
  assert.equal(blocked.pending, 0);
  const allowed = evaluateLevel({ ratio: 0.5, current: 2, lastChangeMs: 1000, nowMs: 1000 + 600_000, config });
  assert.equal(allowed.level, 0);
  assert.equal(allowed.changed, true);
});

test('比率在阈值附近小幅波动不会反复跳变', () => {
  let level = 0;
  let since = 0;
  let changes = 0;
  let now = 0;
  for (const ratio of [0.74, 0.76, 0.74, 0.76, 0.75, 0.74]) {
    now += 60_000;
    const result = evaluateLevel({ ratio, current: level, lastChangeMs: since, nowMs: now, config });
    if (result.changed) {
      level = result.level;
      since = now;
      changes += 1;
    }
  }
  // 0.76 进入关注后，0.74 仍高于退出线 0.70，不会退出
  assert.equal(changes, 1);
  assert.equal(level, 1);
});
