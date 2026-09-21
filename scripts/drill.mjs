#!/usr/bin/env node
import { runDrill } from '../src/drill.mjs';

const { ok, checks, evalLog } = runDrill();

console.log('国庆前联合演练报告（2026-09-26 关闭热门步道 + 两批晚到客流）');
console.log('='.repeat(64));
console.log('评估时间线：');
for (const line of evalLog) console.log(`  ${line}`);
console.log('='.repeat(64));
console.log('检查项：');
for (const c of checks) {
  console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `\n     ${c.detail}` : ''}`);
}
console.log('='.repeat(64));
console.log(ok ? '演练结论：全部检查通过' : '演练结论：存在未通过项');
process.exit(ok ? 0 : 1);
