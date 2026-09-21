import http from 'node:http';
import { createEngine } from './engine.mjs';
import { EngineError } from './validate.mjs';

const MAX_BODY_BYTES = 1_000_000;

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new EngineError('payload_too_large', '请求体过大', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new EngineError('invalid_json', '请求体不是合法 JSON', 400);
  }
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function createApp(configOverrides = {}) {
  const engine = createEngine(configOverrides);

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;
    let m;

    if (method === 'GET' && path === '/health') {
      return send(res, 200, { status: 'ok' });
    }

    // ---- 管理端：分区/点位/经营者/设备注册（幂等 upsert） ----
    if (method === 'PUT' && (m = path.match(/^\/v1\/admin\/(zones|sites|operators|devices)\/([^/]+)$/))) {
      const body = await readJson(req);
      const id = decodeURIComponent(m[2]);
      const kind = m[1];
      const result =
        kind === 'zones'
          ? engine.registerZone({ ...body, id })
          : kind === 'sites'
            ? engine.registerSite({ ...body, id })
            : kind === 'operators'
              ? engine.registerOperator({ ...body, id })
              : engine.registerDevice({ ...body, id });
      return send(res, 200, result);
    }

    // ---- 数据接入：每次接入后立即用当前时间评估一次 ----
    if (method === 'POST' && path === '/v1/occupancy') {
      const body = await readJson(req);
      const result = engine.ingestOccupancy(body.reports);
      engine.evaluate(Date.now());
      return send(res, 200, result);
    }
    if (method === 'POST' && path === '/v1/flows') {
      const body = await readJson(req);
      const result = engine.ingestFlows(body.events);
      engine.evaluate(Date.now());
      return send(res, 200, result);
    }
    if (method === 'POST' && path === '/v1/sites/status') {
      const body = await readJson(req);
      const result = engine.ingestSiteStatuses(Array.isArray(body.events) ? body.events : [body]);
      engine.evaluate(Date.now());
      return send(res, 200, result);
    }
    if (method === 'POST' && path === '/v1/overrides') {
      const body = await readJson(req);
      const result = engine.ingestOverrides(Array.isArray(body.events) ? body.events : [body]);
      engine.evaluate(Date.now());
      return send(res, 200, result);
    }
    if (method === 'DELETE' && (m = path.match(/^\/v1\/overrides\/([^/]+)$/))) {
      return send(res, 200, engine.cancelOverride(decodeURIComponent(m[1]), Date.now()));
    }
    if (method === 'POST' && path === '/v1/groups/bookings') {
      const body = await readJson(req);
      return send(res, 200, engine.ingestGroupBookings(Array.isArray(body.events) ? body.events : [body]));
    }
    if (method === 'POST' && path === '/v1/groups/arrivals') {
      const body = await readJson(req);
      const result = engine.ingestGroupArrivals(Array.isArray(body.events) ? body.events : [body]);
      engine.evaluate(Date.now());
      return send(res, 200, result);
    }
    if (method === 'POST' && path === '/v1/evaluate') {
      const body = await readJson(req);
      return send(res, 200, { summaries: engine.evaluate(body.at ?? Date.now()) });
    }

    // ---- 发布视图（支持 ?at= 时间回溯查看） ----
    if (method === 'GET' && path === '/v1/zones') {
      return send(res, 200, { zones: engine.listZones(url.searchParams.get('at') ?? Date.now()) });
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/zones\/([^/]+)$/))) {
      return send(res, 200, engine.zoneStatus(decodeURIComponent(m[1]), url.searchParams.get('at') ?? Date.now()));
    }
    if (method === 'GET' && path === '/v1/alerts') {
      return send(res, 200, { alerts: engine.listAlerts() });
    }
    if (method === 'GET' && path === '/v1/advisories') {
      return send(res, 200, { advisories: engine.listAdvisories(url.searchParams.get('zoneId') ?? undefined) });
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/operators\/([^/]+)\/prompts$/))) {
      return send(res, 200, { prompts: engine.promptsFor(decodeURIComponent(m[1])) });
    }
    if (method === 'GET' && path === '/v1/privacy/report') {
      return send(res, 200, engine.privacyReport());
    }

    throw new EngineError('not_found', '资源不存在', 404);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      send(res, err.status ?? 500, {
        error: err.code ?? 'internal_error',
        message: err.message,
        ...(err.paths ? { details: err.paths } : {}),
      });
    });
  });

  return { server, engine };
}
