import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.mjs';

const DAY = '2026-09-26';
const T = (h, m = 0) =>
  Date.parse(`${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
const iso = (ts) => new Date(ts).toISOString();

async function startApp() {
  const { server, engine } = createApp({ visitRate: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, engine, base };
}

async function post(base, path, body, method = 'POST') {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('HTTP 端到端：注册 → 接入 → 评估 → 发布视图', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());

  // 管理端注册
  for (const [path, body] of [
    ['/v1/admin/zones/Z1', { name: '一区', baseCapacity: 100 }],
    ['/v1/admin/operators/H1', { zoneId: 'Z1', name: '甲客栈' }],
    ['/v1/admin/devices/D1', { zoneId: 'Z1', kind: 'entrance', expectedIntervalSec: 900 }],
  ]) {
    const res = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
  }

  // 流量接入 + 幂等重发
  const flow = { eventId: 'f1', deviceId: 'D1', windowStart: iso(T(8)), windowEnd: iso(T(8, 15)), entries: 10, exits: 0 };
  const first = await post(base, '/v1/flows', { events: [flow] });
  assert.equal(first.status, 200);
  assert.equal(first.body.applied, 1);
  const retry = await post(base, '/v1/flows', { events: [flow] });
  assert.deepEqual(retry.body.duplicates, ['f1']);

  // 指定时刻评估与发布视图
  const evaluated = await post(base, '/v1/evaluate', { at: iso(T(9)) });
  assert.equal(evaluated.body.summaries.find((s) => s.zoneId === 'Z1').visitors, 10);
  const zones = await fetch(`${base}/v1/zones?at=${encodeURIComponent(iso(T(9)))}`).then((r) => r.json());
  const z1 = zones.zones.find((z) => z.zoneId === 'Z1');
  assert.equal(z1.visitors, 10);
  assert.equal(z1.levelName, '正常');

  // 在店上报（聚合）与经营者提示
  const occ = await post(base, '/v1/occupancy', { reports: [{ eventId: 'o1', operatorId: 'H1', inHouse: 20, occurredAt: iso(T(8)) }] });
  assert.equal(occ.body.applied, 1);
  const prompts = await fetch(`${base}/v1/operators/H1/prompts`).then((r) => r.json());
  assert.deepEqual(prompts.prompts, []);

  // 隐私报告与告警列表可访问
  const privacy = await fetch(`${base}/v1/privacy/report`).then((r) => r.json());
  assert.equal(privacy.ok, true);
  const alerts = await fetch(`${base}/v1/alerts`).then((r) => r.json());
  assert.deepEqual(alerts.alerts, []);
});

test('携带个人字段的负载被 422 拒绝', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  await fetch(`${base}/v1/admin/operators/H1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ zoneId: 'Z1', name: '甲客栈' }),
  });
  const res = await post(base, '/v1/occupancy', {
    reports: [{ eventId: 'o1', operatorId: 'H1', inHouse: 5, occurredAt: iso(T(8)), guestName: '张三' }],
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'person_data_rejected');
  assert.ok(res.body.details.some((p) => p.includes('guestName')));
});

test('未知设备进入 rejected，未知路由 404', async (t) => {
  const { server, base } = await startApp();
  t.after(() => server.close());
  const res = await post(base, '/v1/flows', {
    events: [{ eventId: 'f1', deviceId: 'GHOST', windowStart: iso(T(8)), windowEnd: iso(T(8, 15)), entries: 1, exits: 0 }],
  });
  assert.equal(res.body.rejected[0].reason, 'unknown_device');
  const missing = await fetch(`${base}/v1/nope`);
  assert.equal(missing.status, 404);
});
