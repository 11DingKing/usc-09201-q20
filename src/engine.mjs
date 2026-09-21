import { createStore, bump } from './store.mjs';
import { defaultConfig } from './config.mjs';
import { evaluateLevel, levelMeta } from './levels.mjs';
import { computePressure } from './pressure.mjs';
import { applyLevelTransition } from './alerts.mjs';
import { buildAdvisory } from './advisories.mjs';
import { hashGroupToken, auditPrivacy } from './privacy.mjs';
import {
  assertAllowedKeys,
  assertDayKey,
  badRequest,
  notFound,
  optionalString,
  parseTimeMs,
  requireInt,
  requireString,
} from './util.mjs';

// 引擎：所有写入先过字段白名单与幂等校验，落库后重估受影响分区；
// 读取时也会惰性重估（阈值窗口到期、设备心跳超时等时间因素由此生效）。
export function createEngine({ store = createStore(), config = defaultConfig(), clock } = {}) {
  if (!clock || typeof clock.nowMs !== 'function') {
    throw new Error('必须提供时钟：{ nowMs() }');
  }
  const nowMs = () => clock.nowMs();

  function evaluateZone(zoneId) {
    const at = nowMs();
    const pressure = computePressure(store, config, zoneId, at);
    if (!pressure) throw notFound(`分区不存在：${zoneId}`);
    const state = store.zoneState.get(zoneId) ?? { level: 0, since_ms: at };
    const evaluated = evaluateLevel({
      ratio: pressure.ratio,
      current: state.level,
      lastChangeMs: state.since_ms,
      nowMs: at,
      config,
    });
    const notice = applyLevelTransition(store, config, zoneId, evaluated, at, pressure);
    return { pressure, level: evaluated.level, notice };
  }

  // 住宿在店上报：report_id 幂等；同酒店同住宿日新报告取代旧报告；
  // 团体凭证哈希落库，仅用于拆分去重与超申报扣减
  function ingestStay(body) {
    assertAllowedKeys(body, ['report_id', 'hotel_id', 'zone_id', 'stay_date', 'guests', 'groups']);
    const reportId = requireString(body, 'report_id');
    const hotelId = requireString(body, 'hotel_id');
    const zoneId = requireString(body, 'zone_id');
    if (!store.zones.has(zoneId)) throw notFound(`分区不存在：${zoneId}`);
    const stayDay = assertDayKey(body.stay_date, 'stay_date');
    const guests = requireInt(body, 'guests', { min: 0 });
    const groups = body.groups ?? [];
    if (!Array.isArray(groups)) throw badRequest('groups 必须为数组');
    for (const group of groups) {
      assertAllowedKeys(group, ['token', 'members_at_property', 'declared_total']);
      requireString(group, 'token');
      requireInt(group, 'members_at_property', { min: 0 });
      requireInt(group, 'declared_total', { min: 0 });
      if (group.members_at_property > group.declared_total) {
        throw badRequest('members_at_property 不能超过 declared_total');
      }
    }

    if (store.stayReports.has(reportId)) {
      return { accepted: true, duplicated: true, data_version: store.version };
    }

    const hotelDay = `${hotelId}|${stayDay}`;
    const previousId = store.stayByHotelDay.get(hotelDay);
    if (previousId) {
      const previous = store.stayReports.get(previousId);
      if (previous) previous.superseded = true;
      for (const [key, portion] of store.groupPortions) {
        if (portion.hotel_id === hotelId && portion.stay_day === stayDay) {
          store.groupPortions.delete(key);
        }
      }
    }

    store.stayReports.set(reportId, {
      report_id: reportId,
      hotel_id: hotelId,
      zone_id: zoneId,
      stay_day: stayDay,
      guests,
      superseded: false,
      received_at: new Date(nowMs()).toISOString(),
    });
    store.stayByHotelDay.set(hotelDay, reportId);
    for (const group of groups) {
      const groupHash = hashGroupToken(config, stayDay, group.token);
      store.groupPortions.set(`${groupHash}|${hotelId}|${stayDay}`, {
        group_hash: groupHash,
        hotel_id: hotelId,
        zone_id: zoneId,
        stay_day: stayDay,
        members: group.members_at_property,
        declared_total: group.declared_total,
      });
    }
    bump(store, 'stay_report', reportId, nowMs());
    const { level, notice } = evaluateZone(zoneId);
    return { accepted: true, duplicated: false, data_version: store.version, level, notice };
  }

  // 入口匿名计数：batch_id 幂等（设备重试不产生重复计数）；
  // 按 occurred_at 归属营业日，迟到批次补入发生日并触发重估
  function ingestEntrance(body) {
    assertAllowedKeys(body, ['batch_id', 'counter_id', 'entered', 'exited', 'occurred_at']);
    const batchId = requireString(body, 'batch_id');
    const counterId = requireString(body, 'counter_id');
    const counter = store.counters.get(counterId);
    if (!counter) throw notFound(`计数设备未登记：${counterId}`);
    const entered = requireInt(body, 'entered', { min: 0 });
    const exited = requireInt(body, 'exited', { min: 0 });
    const occurredMs = parseTimeMs(body.occurred_at, 'occurred_at');
    if (occurredMs > nowMs() + config.maxFutureSkewMs) {
      throw badRequest('occurred_at 明显晚于当前时间');
    }

    if (store.entranceBatches.has(batchId)) {
      return { accepted: true, duplicated: true, data_version: store.version };
    }
    const arrivedMs = nowMs();
    store.entranceBatches.set(batchId, {
      batch_id: batchId,
      counter_id: counterId,
      zone_id: counter.zone_id,
      entered,
      exited,
      occurred_ms: occurredMs,
      arrived_ms: arrivedMs,
    });
    bump(store, 'entrance_batch', batchId, arrivedMs);
    const { level, notice } = evaluateZone(counter.zone_id);
    return {
      accepted: true,
      duplicated: false,
      late: arrivedMs - occurredMs > config.lateBatchThresholdMs,
      data_version: store.version,
      level,
      notice,
    };
  }

  function setTrailStatus(body) {
    assertAllowedKeys(body, ['trail_id', 'status', 'reason', 'effective_at']);
    const trailId = requireString(body, 'trail_id');
    const trail = store.trails.get(trailId);
    if (!trail) throw notFound(`步道不存在：${trailId}`);
    const status = requireString(body, 'status');
    if (!['open', 'limited', 'closed'].includes(status)) {
      throw badRequest('status 必须为 open/limited/closed');
    }
    trail.status = status;
    trail.reason = optionalString(body, 'reason');
    trail.updated_ms = body.effective_at ? parseTimeMs(body.effective_at, 'effective_at') : nowMs();
    bump(store, 'trail_status', trailId, nowMs());
    const { level, notice } = evaluateZone(trail.zone_id);
    return { accepted: true, data_version: store.version, level, notice };
  }

  function heartbeat(body) {
    assertAllowedKeys(body, ['counter_id', 'at']);
    const counterId = requireString(body, 'counter_id');
    const counter = store.counters.get(counterId);
    if (!counter) throw notFound(`计数设备未登记：${counterId}`);
    counter.last_heartbeat_ms = body.at ? parseTimeMs(body.at, 'at') : nowMs();
    bump(store, 'heartbeat', counterId, nowMs());
    return { accepted: true, data_version: store.version };
  }

  // 生态阈值临时下调：窗口内生效、到期自动恢复；override_id 幂等
  function setThresholdOverride(body) {
    assertAllowedKeys(body, ['override_id', 'zone_id', 'limit', 'starts_at', 'ends_at', 'reason']);
    const overrideId = requireString(body, 'override_id');
    const zoneId = requireString(body, 'zone_id');
    if (!store.zones.has(zoneId)) throw notFound(`分区不存在：${zoneId}`);
    const limit = requireInt(body, 'limit', { min: 1 });
    const startsMs = parseTimeMs(body.starts_at, 'starts_at');
    const endsMs = parseTimeMs(body.ends_at, 'ends_at');
    if (endsMs <= startsMs) throw badRequest('ends_at 必须晚于 starts_at');
    const reason = requireString(body, 'reason');

    if (store.thresholdOverrides.has(overrideId)) {
      return { accepted: true, duplicated: true, data_version: store.version };
    }
    store.thresholdOverrides.set(overrideId, {
      override_id: overrideId,
      zone_id: zoneId,
      limit,
      starts_ms: startsMs,
      ends_ms: endsMs,
      reason,
    });
    bump(store, 'threshold_override', overrideId, nowMs());
    const { level, notice } = evaluateZone(zoneId);
    return { accepted: true, duplicated: false, data_version: store.version, level, notice };
  }

  function zonePressure(zoneId) {
    const { pressure, level, notice } = evaluateZone(zoneId);
    return {
      ...pressure,
      level,
      level_name: levelMeta(config, level).name,
      notice,
      data_version: store.version,
    };
  }

  function listZones() {
    const zones = [];
    for (const zone of store.zones.values()) {
      const { pressure, level } = evaluateZone(zone.zone_id);
      zones.push({
        zone_id: zone.zone_id,
        name: zone.name,
        level,
        level_name: levelMeta(config, level).name,
        ratio: pressure.ratio,
        effective_limit: pressure.limit.effective,
      });
    }
    return { zones, data_version: store.version };
  }

  function advisory(zoneId) {
    if (!store.zones.has(zoneId)) throw notFound(`分区不存在：${zoneId}`);
    evaluateZone(zoneId);
    return { ...buildAdvisory(store, config, zoneId, nowMs()), data_version: store.version };
  }

  function alerts() {
    const active = [];
    for (const zone of store.zones.values()) {
      const { level } = evaluateZone(zone.zone_id);
      if (level > 0) {
        const state = store.zoneState.get(zone.zone_id);
        active.push({
          zone_id: zone.zone_id,
          name: zone.name,
          level,
          level_name: levelMeta(config, level).name,
          since: new Date(state.since_ms).toISOString(),
        });
      }
    }
    return { active, notifications: store.notifications.slice(-100), data_version: store.version };
  }

  function privacyAudit() {
    return { ...auditPrivacy(store), data_version: store.version };
  }

  return {
    store,
    config,
    evaluateZone,
    ingestStay,
    ingestEntrance,
    setTrailStatus,
    heartbeat,
    setThresholdOverride,
    zonePressure,
    listZones,
    advisory,
    alerts,
    privacyAudit,
  };
}
