import assert from 'node:assert/strict';
import test from 'node:test';
import { runDrill } from '../src/drill.mjs';

test('国庆前联合演练：全部检查通过', () => {
  const report = runDrill();
  assert.equal(report.passed, true);
  for (const check of report.checks) {
    assert.equal(check.passed, true, `检查未通过：${check.name}`);
  }
});

test('演练通知序列为 发布-升级-升级-降级-解除，无反复跳变', () => {
  const report = runDrill();
  assert.deepEqual(
    report.notifications.map((n) => n.type),
    ['issued', 'escalated', 'escalated', 'downgraded', 'resolved'],
  );
  assert.deepEqual(report.notifications.map((n) => n.to_level), [1, 2, 3, 1, 0]);
});

test('演练时间线覆盖关闭步道与两批晚到客流的关键节点', () => {
  const report = runDrill();
  const steps = report.timeline.map((entry) => entry.step);
  assert.deepEqual(steps, ['baseline', 'resend', 'closure', 'late-a', 'late-b', 'replay', 'exit-1', 'exit-2']);
  const byId = Object.fromEntries(report.timeline.map((entry) => [entry.step, entry]));
  assert.equal(byId.baseline.effective_limit, 800);
  assert.equal(byId.closure.effective_limit, 700);
  assert.equal(byId['late-a'].level, 2);
  assert.equal(byId['late-b'].level, 3);
  assert.equal(byId.replay.deduplicated, true);
  assert.equal(byId['exit-2'].level, 0);
});

test('演练高峰期经营建议包含替代分区与封闭步道信息', () => {
  const report = runDrill();
  const advisory = report.peak_advisory;
  assert.equal(advisory.level, 3);
  assert.ok(advisory.alternatives.length > 0);
  assert.ok(advisory.closed_trails.some((trail) => trail.trail_id === 't-summit'));
  assert.ok(advisory.actions.length > 0);
});

test('演练隐私边界：审计通过且存储中无原始团体凭证', () => {
  const report = runDrill();
  assert.equal(report.privacy.ok, true);
  assert.equal(JSON.stringify(report.timeline).includes('GRP-001'), false);
  assert.equal(JSON.stringify(report.notifications).includes('GRP-001'), false);
});
