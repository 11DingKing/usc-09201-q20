import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfig } from '../src/config.mjs';
import { createLevelState, desiredLevel, stepLevel } from '../src/levels.mjs';

test('升级需要连续确认，目标变化重新计数', () => {
  const config = createConfig();
  const state = createLevelState();
  assert.equal(desiredLevel(0.86, 0, 0, config), 2);
  assert.equal(stepLevel(state, 2, 1000, config), false); // 第 1 次，未确认
  assert.equal(state.level, 0);
  assert.equal(stepLevel(state, 1, 2000, config), false); // 目标变化，重新计数
  assert.equal(stepLevel(state, 2, 3000, config), false); // 重新第 1 次
  assert.equal(stepLevel(state, 2, 4000, config), true); // 连续第 2 次，确认
  assert.equal(state.level, 2);
});

test('限流等级快速升级，一次评估即确认', () => {
  const config = createConfig();
  const state = createLevelState();
  assert.equal(stepLevel(state, 3, 1000, config), true);
  assert.equal(state.level, 3);
});

test('退出阈值形成回差，边界附近不抖动', () => {
  const config = createConfig();
  // 0.96 仍高于限流退出线 0.95 → 保持
  assert.equal(desiredLevel(0.96, 0, 3, config), 3);
  // 0.94 跌破 0.95 但高于预警退出线 0.80 → 只退到预警
  assert.equal(desiredLevel(0.94, 0, 3, config), 2);
  // 0.83 介于预警进入 0.85 与退出 0.80 之间 → 维持当前等级（迟滞保持）
  assert.equal(desiredLevel(0.83, 0, 2, config), 2);
  assert.equal(desiredLevel(0.83, 0, 1, config), 1);
});

test('预测分量最多推到预警，限流必须由实测触发', () => {
  const config = createConfig();
  assert.equal(desiredLevel(0.1, 1.5, 0, config), 2);
  assert.equal(desiredLevel(1.2, 0, 0, config), 3);
});

test('降级也需要连续确认', () => {
  const config = createConfig();
  const state = createLevelState();
  stepLevel(state, 3, 0, config);
  assert.equal(stepLevel(state, 0, 1000, config), false);
  assert.equal(state.level, 3);
  assert.equal(stepLevel(state, 0, 2000, config), true);
  assert.equal(state.level, 0);
});
