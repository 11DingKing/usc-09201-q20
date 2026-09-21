import { LEVEL_NAMES, createConfig } from './config.mjs';
import {
  activeOverrideFactor,
  applyFlow,
  applyGroupArrival,
  applyGroupBooking,
  applyOccupancy,
  applyOverride,
  applySiteStatus,
  cancelOverride as storeCancelOverride,
  createStore,
  hasSeen,
  inHouseTotal,
  markSeen,
  siteVisitorsNow,
  snapshotStore,
  visitorsNow,
} from './store.mjs';
import { createLevelState, desiredLevel, stepLevel } from './levels.mjs';
import {
  assertNoPersonData,
  createGroupKeyer,
  scanForForbiddenKeys,
  suppressSmallCount,
} from './privacy.mjs';
import { dayKeyOf, remainingFraction } from './time.mjs';
import { advisoryKey, buildActions, selectAlternatives } from './advisory.mjs';
import { EngineError, ensureNonNegInt, ensurePositiveInt, ensureTs, requireFields } from './validate.mjs';

const PROMPT_KIND = { 1: 'attention', 2: 'warning', 3: 'restriction' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GROUP_KEY_RE = /^[0-9a-f]{24}$/;

function round3(value) {
  return value == null || !Number.isFinite(value) ? value : Math.round(value * 1000) / 1000;
}

function asTs(value, field = 'now') {
  if (value == null) return Date.now();
  return typeof value === 'number' ? value : ensureTs(value, field);
}

/**
 * 承载预警引擎：数据接入（幂等、隐私清洗）→ 压力评估（迟滞状态机）→
 * 告警生命周期 → 经营者建议与提示。所有评估显式接受时间参数，便于演练与测试。
 */
export function createEngine(configOverrides = {}) {
  const config = createConfig(configOverrides);
  const store = createStore(config);
  const keyer = createGroupKeyer();
  const levelStates = new Map(); // zoneId -> 状态机
  const transitions = [];
  const alerts = [];
  const advisories = [];
  let lastEvalDay = null;

  const levelStateOf = (zoneId) => {
    if (!levelStates.has(zoneId)) levelStates.set(zoneId, createLevelState());
    return levelStates.get(zoneId);
  };

  const zoneOrThrow = (zoneId) => {
    const zone = store.zones.get(zoneId);
    if (!zone) throw new EngineError('unknown_zone', `未知分区: ${zoneId}`, 404);
    return zone;
  };

  // ---------- 注册（管理端，幂等 upsert） ----------

  function registerZone(body) {
    requireFields(body, ['id', 'name', 'baseCapacity'], '分区');
    ensurePositiveInt(body.baseCapacity, 'baseCapacity');
    store.zones.set(body.id, {
      id: body.id,
      name: String(body.name),
      baseCapacity: body.baseCapacity,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
    });
    return { registered: 'zone', id: body.id };
  }

  function registerSite(body) {
    requireFields(body, ['id', 'zoneId', 'kind', 'name', 'baseCapacity'], '点位');
    zoneOrThrow(body.zoneId);
    if (!['trail', 'water'].includes(body.kind)) {
      throw new EngineError('invalid_field', 'kind 必须是 trail 或 water');
    }
    ensurePositiveInt(body.baseCapacity, 'baseCapacity');
    const prev = store.sites.get(body.id);
    store.sites.set(body.id, {
      id: body.id,
      zoneId: body.zoneId,
      kind: body.kind,
      name: String(body.name),
      baseCapacity: body.baseCapacity,
      status: prev?.status ?? 'open',
      statusAt: prev?.statusAt ?? null,
    });
    return { registered: 'site', id: body.id };
  }

  function registerOperator(body) {
    requireFields(body, ['id', 'zoneId', 'name'], '经营者');
    zoneOrThrow(body.zoneId);
    store.operators.set(body.id, { id: body.id, zoneId: body.zoneId, name: String(body.name) });
    return { registered: 'operator', id: body.id };
  }

  function registerDevice(body) {
    requireFields(body, ['id', 'zoneId', 'kind'], '设备');
    zoneOrThrow(body.zoneId);
    if (!['entrance', 'site'].includes(body.kind)) {
      throw new EngineError('invalid_field', 'kind 必须是 entrance 或 site');
    }
    if (body.siteId != null) {
      const site = store.sites.get(body.siteId);
      if (!site || site.zoneId !== body.zoneId) {
        throw new EngineError('unknown_site', `未知点位: ${body.siteId}`, 404);
      }
    }
    const expectedIntervalSec = body.expectedIntervalSec ?? config.windowSec;
    ensurePositiveInt(expectedIntervalSec, 'expectedIntervalSec');
    store.devices.set(body.id, {
      id: body.id,
      zoneId: body.zoneId,
      kind: body.kind,
      siteId: body.siteId ?? null,
      expectedIntervalSec,
      registeredAt: body.registeredAt != null ? ensureTs(body.registeredAt, 'registeredAt') : Date.now(),
    });
    return { registered: 'device', id: body.id };
  }

  // ---------- 数据接入 ----------

  /**
   * 批量接入通用流程：eventId 判重 → 单条校验清洗 → 生效。
   * 单条校验失败记入 rejected 不影响整批；个人数据（PrivacyError）则整批拒绝。
   */
  function ingestBatch(items, applyOne) {
    const result = { applied: 0, duplicates: [], rejected: [] };
    for (const item of items ?? []) {
      try {
        if (!item?.eventId) throw new EngineError('missing_fields', '缺少 eventId');
        if (hasSeen(store, item.eventId)) {
          result.duplicates.push(item.eventId);
          continue;
        }
        const outcome = applyOne(item);
        markSeen(store, item.eventId);
        if (outcome === 'duplicate') result.duplicates.push(item.eventId);
        else result.applied += 1;
      } catch (err) {
        if (err instanceof EngineError) {
          result.rejected.push({ eventId: item?.eventId ?? null, reason: err.code, message: err.message });
        } else {
          throw err;
        }
      }
    }
    return result;
  }

  /** 入口/点位计数窗口。迟到数据按发生窗口入库，重复补报由 eventId 判重。 */
  function ingestFlows(events) {
    return ingestBatch(events, (e) => {
      assertNoPersonData(e);
      requireFields(e, ['eventId', 'deviceId', 'windowStart', 'windowEnd', 'entries', 'exits'], '流量窗口');
      const device = store.devices.get(e.deviceId);
      if (!device) throw new EngineError('unknown_device', `未知设备: ${e.deviceId}`);
      ensureNonNegInt(e.entries, 'entries');
      ensureNonNegInt(e.exits, 'exits');
      const windowStart = ensureTs(e.windowStart, 'windowStart');
      const windowEnd = ensureTs(e.windowEnd, 'windowEnd');
      if (windowEnd <= windowStart) {
        throw new EngineError('invalid_field', 'windowEnd 必须晚于 windowStart');
      }
      let siteId = null;
      if (e.siteId != null) {
        const site = store.sites.get(e.siteId);
        if (!site || site.zoneId !== device.zoneId) {
          throw new EngineError('unknown_site', `未知点位: ${e.siteId}`);
        }
        siteId = e.siteId;
      }
      applyFlow(store, {
        eventId: e.eventId,
        deviceId: device.id,
        zoneId: device.zoneId,
        siteId,
        windowStart,
        windowEnd,
        entries: e.entries,
        exits: e.exits,
      });
      return 'applied';
    });
  }

  /** 住宿经营者在店人数上报（仅聚合计数）。 */
  function ingestOccupancy(reports) {
    return ingestBatch(reports, (r) => {
      assertNoPersonData(r);
      requireFields(r, ['eventId', 'operatorId', 'inHouse', 'occurredAt'], '在店上报');
      if (!store.operators.has(r.operatorId)) {
        throw new EngineError('unknown_operator', `未知经营者: ${r.operatorId}`);
      }
      ensureNonNegInt(r.inHouse, 'inHouse');
      applyOccupancy(store, {
        eventId: r.eventId,
        operatorId: r.operatorId,
        inHouse: r.inHouse,
        occurredAt: ensureTs(r.occurredAt, 'occurredAt'),
      });
      return 'applied';
    });
  }

  /** 步道/水源点状态（开放、临时封闭）。 */
  function ingestSiteStatuses(items, now = Date.now()) {
    return ingestBatch(items, (e) => {
      assertNoPersonData(e);
      requireFields(e, ['eventId', 'siteId', 'status'], '点位状态');
      if (!store.sites.has(e.siteId)) throw new EngineError('unknown_site', `未知点位: ${e.siteId}`);
      if (!['open', 'closed'].includes(e.status)) {
        throw new EngineError('invalid_field', 'status 必须是 open 或 closed');
      }
      const at = e.effectiveAt != null ? ensureTs(e.effectiveAt, 'effectiveAt') : now;
      applySiteStatus(store, e.siteId, e.status, at);
      return 'applied';
    });
  }

  /** 生态阈值临时调整（降雨等），带生效窗口，到期自动恢复。 */
  function ingestOverrides(items) {
    return ingestBatch(items, (e) => {
      assertNoPersonData(e);
      requireFields(e, ['eventId', 'targetType', 'targetId', 'factor', 'startsAt', 'endsAt'], '阈值调整');
      if (!['zone', 'site'].includes(e.targetType)) {
        throw new EngineError('invalid_field', 'targetType 必须是 zone 或 site');
      }
      const known = e.targetType === 'zone' ? store.zones.has(e.targetId) : store.sites.has(e.targetId);
      if (!known) throw new EngineError('unknown_target', `未知阈值调整目标: ${e.targetId}`);
      if (typeof e.factor !== 'number' || !(e.factor > 0 && e.factor <= 1)) {
        throw new EngineError('invalid_field', 'factor 必须在 (0,1] 区间');
      }
      const startsAt = ensureTs(e.startsAt, 'startsAt');
      const endsAt = ensureTs(e.endsAt, 'endsAt');
      if (endsAt <= startsAt) throw new EngineError('invalid_field', 'endsAt 必须晚于 startsAt');
      applyOverride(store, {
        id: e.eventId,
        targetType: e.targetType,
        targetId: e.targetId,
        factor: e.factor,
        startsAt,
        endsAt,
        reason: String(e.reason ?? '').slice(0, 120),
      });
      return 'applied';
    });
  }

  function cancelOverride(id, now = Date.now()) {
    if (!storeCancelOverride(store, id, now)) {
      throw new EngineError('unknown_override', `未知阈值调整: ${id}`, 404);
    }
    return { cancelled: id };
  }

  /** 团体预约。团体标识立即按日散列，原始 ID 不入库。 */
  function ingestGroupBookings(items, now = Date.now()) {
    return ingestBatch(items, (b) => {
      assertNoPersonData(b);
      requireFields(b, ['eventId', 'groupId', 'zoneId', 'expectedSize'], '团体预约');
      zoneOrThrow(b.zoneId);
      ensurePositiveInt(b.expectedSize, 'expectedSize');
      const day = b.forDate ?? dayKeyOf(now, config.tzOffsetMinutes);
      if (!DATE_RE.test(day)) throw new EngineError('invalid_field', 'forDate 必须是 YYYY-MM-DD');
      const groupKey = keyer.keyFor(b.groupId, day);
      applyGroupBooking(store, groupKey, {
        zoneId: b.zoneId,
        expectedSize: b.expectedSize,
        day,
        operatorId: b.operatorId ?? null,
      });
      return 'applied';
    });
  }

  /** 团体到园（整团或分批）。未预约团体需携带 zoneId，按异常记录但正常计数。 */
  function ingestGroupArrivals(items) {
    return ingestBatch(items, (e) => {
      assertNoPersonData(e);
      requireFields(e, ['eventId', 'groupId', 'kind', 'count', 'occurredAt'], '团体到园');
      if (!['whole', 'part'].includes(e.kind)) {
        throw new EngineError('invalid_field', 'kind 必须是 whole 或 part');
      }
      if (e.kind === 'part' && (e.partId == null || e.partId === '')) {
        throw new EngineError('missing_fields', 'part 类型缺少 partId');
      }
      ensurePositiveInt(e.count, 'count');
      const occurredAt = ensureTs(e.occurredAt, 'occurredAt');
      const day = dayKeyOf(occurredAt, config.tzOffsetMinutes);
      const groupKey = keyer.keyFor(e.groupId, day);
      const booking = store.groups.get(groupKey);
      const zoneId = booking?.zoneId ?? e.zoneId;
      if (!zoneId || !store.zones.has(zoneId)) {
        throw new EngineError('unknown_zone', '团体到园缺少有效分区（未预约且未携带 zoneId）');
      }
      const outcome = applyGroupArrival(store, groupKey, {
        zoneId,
        day,
        kind: e.kind,
        partId: e.partId ?? null,
        count: e.count,
        occurredAt,
        eventId: e.eventId,
      });
      return outcome === 'duplicate_part' ? 'duplicate' : 'applied';
    });
  }

  // ---------- 压力评估 ----------

  function computeMetrics(zoneId, now) {
    const zone = zoneOrThrow(zoneId);
    const visitors = visitorsNow(store, zoneId, now);
    const capacity = Math.max(1, Math.round(zone.baseCapacity * activeOverrideFactor(store, 'zone', zoneId, now)));
    const inHouse = inHouseTotal(store, zoneId, now);
    const expectedVisits = Math.round(inHouse * config.visitRate * remainingFraction(now, config));
    const zoneRatio = visitors / capacity;
    const forecastRatio = (visitors + expectedVisits) / capacity;
    const sites = [...store.sites.values()]
      .filter((site) => site.zoneId === zoneId)
      .map((site) => {
        const count = siteVisitorsNow(store, site.id, now);
        const cap = Math.max(0, Math.round(site.baseCapacity * activeOverrideFactor(store, 'site', site.id, now)));
        const ratio = site.status === 'open' && cap > 0 ? count / cap : null;
        return { siteId: site.id, name: site.name, kind: site.kind, status: site.status, visitors: count, capacity: cap, ratio };
      });
    const siteRatios = sites.filter((s) => s.ratio != null).map((s) => s.ratio);
    // 分区实测压力取分区整体与最紧张点位的较大者（水源点等局部过载同样抬升等级）
    const currentRatio = Math.max(zoneRatio, ...siteRatios);
    const offlineDevices = [...store.devices.values()]
      .filter((d) => d.zoneId === zoneId && d.kind === 'entrance')
      .filter((d) => {
        const last = store.deviceLastWindowEnd.get(d.id) ?? d.registeredAt ?? 0;
        return now - last > d.expectedIntervalSec * 1000 * config.deviceOfflineFactor;
      })
      .map((d) => d.id);
    return {
      zoneId,
      name: zone.name,
      tags: zone.tags,
      visitors,
      capacity,
      inHouse,
      expectedVisits,
      zoneRatio,
      forecastRatio,
      currentRatio,
      sites,
      offlineDevices,
      degraded: offlineDevices.length > 0,
      hasOpenSites: sites.some((s) => s.status === 'open'),
    };
  }

  function updateAlert(zoneId, to, now) {
    const open = alerts.find((a) => a.zoneId === zoneId && a.resolvedAt == null);
    if (to >= 2 && !open) {
      alerts.push({
        id: `AL-${String(alerts.length + 1).padStart(3, '0')}`,
        zoneId,
        openedAt: now,
        level: to,
        history: [{ at: now, level: to }],
        resolvedAt: null,
        resolution: null,
      });
    } else if (open && to >= 2 && to !== open.level) {
      open.level = to;
      open.history.push({ at: now, level: to });
    } else if (open && to <= 1) {
      open.resolvedAt = now;
      open.resolution = 'level_normalized';
    }
  }

  function updateAdvisories(zoneId, level, metrics, now) {
    const actives = advisories.filter((a) => a.zoneId === zoneId && a.resolvedAt == null);
    if (level < 1) {
      for (const active of actives) active.resolvedAt = now;
      return;
    }
    const view = new Map();
    for (const [id, m] of metrics) {
      view.set(id, {
        name: m.name,
        tags: m.tags,
        level: levelStateOf(id).level,
        visitors: m.visitors,
        capacity: m.capacity,
        hasOpenSites: m.hasOpenSites,
      });
    }
    const alternatives = level >= 2 ? selectAlternatives(view, zoneId, config) : [];
    const key = advisoryKey(zoneId, level, alternatives);
    const sameActive = actives.find((a) => a.key === key);
    for (const active of actives) {
      if (active !== sameActive) active.resolvedAt = now;
    }
    if (sameActive) return; // 内容未变，继续沿用，不重复发布
    const recentSameKey = advisories
      .filter((a) => a.zoneId === zoneId && a.key === key && a.resolvedAt != null)
      .sort((a, b) => b.publishedAt - a.publishedAt)[0];
    if (recentSameKey && now - recentSameKey.publishedAt < config.advisoryCooldownSec * 1000) {
      recentSameKey.resolvedAt = null; // 冷却期内恢复最近一条，避免相同内容反复发布
      return;
    }
    const closedSites = [...store.sites.values()]
      .filter((s) => s.zoneId === zoneId && s.status === 'closed')
      .map((s) => ({ name: s.name }));
    advisories.push({
      id: `AD-${String(advisories.length + 1).padStart(3, '0')}`,
      zoneId,
      level,
      levelName: LEVEL_NAMES[level],
      key,
      publishedAt: now,
      resolvedAt: null,
      alternatives,
      actions: buildActions({ level, closedSites, alternatives }),
    });
  }

  /**
   * 全量评估：先计算各分区压力并推进状态机，再统一处理告警与建议，
   * 保证建议使用的是全部分区的最新等级。
   */
  function evaluate(nowInput) {
    const now = asTs(nowInput);
    const day = dayKeyOf(now, config.tzOffsetMinutes);
    if (lastEvalDay !== day) {
      if (lastEvalDay) keyer.retainOnly(day); // 日切：丢弃旧盐，切断跨日关联
      lastEvalDay = day;
    }
    const metrics = new Map();
    for (const zoneId of store.zones.keys()) metrics.set(zoneId, computeMetrics(zoneId, now));

    const changed = [];
    for (const [zoneId, m] of metrics) {
      const state = levelStateOf(zoneId);
      const desired = desiredLevel(m.currentRatio, m.forecastRatio, state.level, config);
      const from = state.level;
      const didChange = stepLevel(state, desired, now, config);
      Object.assign(m, { level: state.level, desired, pendingLevel: state.pendingLevel, changed: didChange });
      if (didChange) {
        transitions.push({ zoneId, from, to: state.level, at: now });
        changed.push({ zoneId, to: state.level });
      }
    }
    for (const { zoneId, to } of changed) {
      updateAlert(zoneId, to, now);
      updateAdvisories(zoneId, to, metrics, now);
    }
    return [...metrics.values()].map((m) => ({
      zoneId: m.zoneId,
      level: m.level,
      levelName: LEVEL_NAMES[m.level],
      desired: m.desired,
      pendingLevel: m.pendingLevel,
      changed: m.changed,
      visitors: m.visitors,
      capacity: m.capacity,
      expectedVisits: m.expectedVisits,
      zoneRatio: round3(m.zoneRatio),
      forecastRatio: round3(m.forecastRatio),
      currentRatio: round3(m.currentRatio),
      degraded: m.degraded,
      offlineDevices: m.offlineDevices,
    }));
  }

  // ---------- 对外视图 ----------

  /** 分区状态发布视图：小计数按 k-匿名抑制，不含任何个人数据。 */
  function zoneStatus(zoneId, nowInput) {
    const now = asTs(nowInput);
    const m = computeMetrics(zoneId, now);
    const state = levelStateOf(zoneId);
    const k = config.kAnonymity;
    const zoneCount = suppressSmallCount(m.visitors, k);
    return {
      zoneId,
      name: m.name,
      level: state.level,
      levelName: LEVEL_NAMES[state.level],
      ratio: round3(m.currentRatio),
      forecastRatio: round3(m.forecastRatio),
      visitors: zoneCount.count,
      visitorsSuppressed: zoneCount.suppressed,
      capacity: m.capacity,
      expectedVisits: m.expectedVisits,
      degraded: m.degraded,
      offlineDevices: m.offlineDevices,
      sites: m.sites.map((site) => {
        const count = suppressSmallCount(site.visitors, k);
        return {
          ...site,
          ratio: site.ratio == null ? null : round3(site.ratio),
          visitors: count.count,
          visitorsSuppressed: count.suppressed,
        };
      }),
      activeAdvisories: advisories
        .filter((a) => a.zoneId === zoneId && a.resolvedAt == null)
        .map((a) => ({
          id: a.id,
          level: a.level,
          levelName: a.levelName,
          actions: a.actions,
          alternatives: a.alternatives,
          publishedAt: a.publishedAt,
        })),
      updatedAt: new Date(now).toISOString(),
    };
  }

  function listZones(nowInput) {
    return [...store.zones.keys()].map((id) => zoneStatus(id, nowInput));
  }

  function listAlerts() {
    return alerts;
  }

  function listAdvisories(zoneId) {
    return zoneId ? advisories.filter((a) => a.zoneId === zoneId) : advisories;
  }

  /** 经营者提示：本区等级行动建议 + 作为分流目的地的接待准备提示。 */
  function promptsFor(operatorId) {
    const operator = store.operators.get(operatorId);
    if (!operator) throw new EngineError('unknown_operator', `未知经营者: ${operatorId}`, 404);
    const prompts = [];
    for (const adv of advisories) {
      if (adv.resolvedAt != null) continue;
      const zone = store.zones.get(adv.zoneId);
      if (adv.zoneId === operator.zoneId) {
        prompts.push({
          kind: PROMPT_KIND[adv.level] ?? 'attention',
          advisoryId: adv.id,
          zoneId: adv.zoneId,
          level: adv.level,
          levelName: adv.levelName,
          message: `【${adv.levelName}】${zone?.name ?? adv.zoneId} 当前为「${adv.levelName}」等级，请按建议行动。`,
          actions: adv.actions,
          publishedAt: adv.publishedAt,
        });
      } else if (adv.level >= 2 && adv.alternatives.some((a) => a.zoneId === operator.zoneId)) {
        prompts.push({
          kind: 'diversion_incoming',
          advisoryId: adv.id,
          zoneId: operator.zoneId,
          fromZoneId: adv.zoneId,
          message: `【分流准备】${zone?.name ?? adv.zoneId} 正在执行分流，${operator.name} 所在区域可能迎来转入客流，请预留接待能力。`,
          publishedAt: adv.publishedAt,
        });
      }
    }
    return prompts;
  }

  function snapshot() {
    return { ...snapshotStore(store), alerts, advisories, transitions };
  }

  /** 隐私自检：存储快照无个人字段，团体标识全部为按日散列键。 */
  function privacyReport() {
    const scan = scanForForbiddenKeys(snapshot());
    const violations = [...scan.violations];
    for (const key of store.groups.keys()) {
      if (!GROUP_KEY_RE.test(key)) violations.push(`groups: 未散列的团体标识 ${key}`);
    }
    return { ok: violations.length === 0, violations };
  }

  return {
    config,
    registerZone,
    registerSite,
    registerOperator,
    registerDevice,
    ingestFlows,
    ingestOccupancy,
    ingestSiteStatuses,
    ingestOverrides,
    cancelOverride,
    ingestGroupBookings,
    ingestGroupArrivals,
    evaluate,
    computeMetrics,
    zoneStatus,
    listZones,
    listAlerts,
    listAdvisories,
    promptsFor,
    privacyReport,
    snapshot,
    visitorsNow: (zoneId, now) => visitorsNow(store, zoneId, asTs(now)),
    transitions: () => transitions,
    levelOf: (zoneId) => levelStateOf(zoneId).level,
  };
}
