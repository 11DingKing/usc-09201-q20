import { createStore } from './store.mjs';
import { defaultConfig } from './config.mjs';
import { createEngine } from './engine.mjs';
import { seedStore } from './seed.mjs';
import { runDrill } from './drill.mjs';
import { badRequest, notFound } from './util.mjs';

// 路由与角色：device 上报计数与心跳，hotel 上报在店，operator 读取分区等级与建议，
// manager 负责阈值、步道、演练与隐私审计；健康检查公开。
const ROUTES = [
  { method: 'GET', pattern: '/health', roles: null, handle: () => ({ status: 'ok' }) },
  { method: 'POST', pattern: '/ingest/stay', roles: ['hotel', 'manager'], handle: (ctx) => ctx.engine.ingestStay(ctx.body) },
  { method: 'POST', pattern: '/ingest/entrance', roles: ['device', 'manager'], handle: (ctx) => ctx.engine.ingestEntrance(ctx.body) },
  { method: 'POST', pattern: '/ingest/trail-status', roles: ['manager'], handle: (ctx) => ctx.engine.setTrailStatus(ctx.body) },
  { method: 'POST', pattern: '/devices/heartbeat', roles: ['device', 'manager'], handle: (ctx) => ctx.engine.heartbeat(ctx.body) },
  { method: 'POST', pattern: '/thresholds/override', roles: ['manager'], handle: (ctx) => ctx.engine.setThresholdOverride(ctx.body) },
  { method: 'GET', pattern: '/zones', roles: ['operator', 'manager'], handle: (ctx) => ctx.engine.listZones() },
  { method: 'GET', pattern: '/zones/:zoneId/pressure', roles: ['operator', 'manager'], handle: (ctx) => ctx.engine.zonePressure(ctx.params.zoneId) },
  { method: 'GET', pattern: '/zones/:zoneId/advisory', roles: ['operator', 'manager'], handle: (ctx) => ctx.engine.advisory(ctx.params.zoneId) },
  { method: 'GET', pattern: '/alerts', roles: ['operator', 'manager'], handle: (ctx) => ctx.engine.alerts() },
  { method: 'GET', pattern: '/privacy/audit', roles: ['manager'], handle: (ctx) => ctx.engine.privacyAudit() },
  { method: 'POST', pattern: '/drill/run', roles: ['manager'], handle: () => runDrill() },
];

export function createApp({ config, seed = true, clock } = {}) {
  const finalConfig = config ?? defaultConfig();
  const finalClock = clock ?? { nowMs: () => Date.now() };
  const store = createStore();
  if (seed) seedStore(store, finalClock.nowMs());
  const engine = createEngine({ store, config: finalConfig, clock: finalClock });

  async function handler(request, response) {
    const path = new URL(request.url, 'http://localhost').pathname;
    try {
      const route = ROUTES.find((item) => item.method === request.method && matchRoute(item.pattern, path));
      if (!route) throw notFound('接口不存在');
      if (route.roles) {
        const role = request.headers['x-role'];
        if (!role) throw Object.assign(new Error('缺少 x-role 请求头'), { status: 401, code: 'unauthorized' });
        if (!route.roles.includes(role)) {
          throw Object.assign(new Error('当前角色无权访问该接口'), { status: 403, code: 'forbidden' });
        }
      }
      const body = request.method === 'POST' ? await readJson(request) : {};
      const payload = await route.handle({ engine, store, body, params: matchRoute(route.pattern, path) });
      sendJson(response, 200, payload);
    } catch (error) {
      const status = error.status ?? 500;
      if (status === 500) console.error(error);
      sendJson(response, status, {
        error: {
          code: error.code ?? 'internal_error',
          message: status === 500 ? '服务内部错误' : error.message,
          details: error.details,
        },
      });
    }
  }

  return { handler, store, engine, config: finalConfig };
}

function matchRoute(pattern, path) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    else if (patternParts[i] !== pathParts[i]) return null;
  }
  return params;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(badRequest('请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(badRequest('请求体不是合法 JSON'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}
