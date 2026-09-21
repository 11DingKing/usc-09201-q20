import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.mjs';

async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server.address().port);
  } finally {
    server.close();
  }
}

async function call(port, method, path, { role, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(role ? { 'x-role': role } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test('健康检查公开，受保护接口缺少角色返回 401', async () => {
  await withServer(async (port) => {
    const health = await call(port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: 'ok' });
    const denied = await call(port, 'GET', '/zones');
    assert.equal(denied.status, 401);
  });
});

test('角色越权返回 403', async () => {
  await withServer(async (port) => {
    const denied = await call(port, 'POST', '/thresholds/override', {
      role: 'hotel',
      body: { override_id: 'o1', zone_id: 'z-cloud', limit: 100, starts_at: '2026-09-26T00:00:00+08:00', ends_at: '2026-09-26T01:00:00+08:00', reason: 'x' },
    });
    assert.equal(denied.status, 403);
    const audit = await call(port, 'GET', '/privacy/audit', { role: 'operator' });
    assert.equal(audit.status, 403);
  });
});

test('酒店上报在店后经营方可读取分区压力与建议', async () => {
  await withServer(async (port) => {
    const stay = await call(port, 'POST', '/ingest/stay', {
      role: 'hotel',
      body: { report_id: 'r1', hotel_id: 'h1', zone_id: 'z-cloud', stay_date: '2026-09-26', guests: 120 },
    });
    assert.equal(stay.status, 200);
    assert.equal(stay.body.accepted, true);

    const pressure = await call(port, 'GET', '/zones/z-cloud/pressure', { role: 'operator' });
    assert.equal(pressure.status, 200);
    assert.equal(typeof pressure.body.data_version, 'number');
    assert.equal(typeof pressure.body.ratio, 'number');
    assert.equal(typeof pressure.body.level_name, 'string');

    const advisory = await call(port, 'GET', '/zones/z-cloud/advisory', { role: 'operator' });
    assert.equal(advisory.status, 200);
    assert.ok(Array.isArray(advisory.body.actions));

    const alerts = await call(port, 'GET', '/alerts', { role: 'operator' });
    assert.equal(alerts.status, 200);
    assert.ok(Array.isArray(alerts.body.active));
  });
});

test('设备角色不能上报在店数据', async () => {
  await withServer(async (port) => {
    const denied = await call(port, 'POST', '/ingest/stay', {
      role: 'device',
      body: { report_id: 'r1', hotel_id: 'h1', zone_id: 'z-cloud', stay_date: '2026-09-26', guests: 1 },
    });
    assert.equal(denied.status, 403);
  });
});

test('非法 JSON 与未知接口返回规范错误', async () => {
  await withServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/ingest/stay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-role': 'hotel' },
      body: '{not-json',
    });
    assert.equal(response.status, 400);
    const missing = await call(port, 'GET', '/nope', { role: 'manager' });
    assert.equal(missing.status, 404);
  });
});

test('管理方触发联合演练并返回通过报告', async () => {
  await withServer(async (port) => {
    const drill = await call(port, 'POST', '/drill/run', { role: 'manager' });
    assert.equal(drill.status, 200);
    assert.equal(drill.body.passed, true);
    assert.ok(drill.body.checks.length >= 6);
  });
});
