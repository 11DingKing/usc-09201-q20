import assert from 'node:assert/strict';
import test from 'node:test';
import { runDrill } from '../src/drill.mjs';

test('国庆前联合演练：全部检查通过', () => {
  const { ok, checks, evalLog } = runDrill();
  assert.ok(evalLog.length > 0, '应输出评估时间线');
  assert.ok(checks.length >= 13, '应覆盖全部演练检查项');
  const failed = checks.filter((c) => !c.ok);
  assert.deepEqual(failed, [], `未通过项: ${failed.map((c) => c.name).join('; ')}`);
  assert.equal(ok, true);
});
