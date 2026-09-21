import { dayKeyOf } from './time.mjs';

/**
 * 内存事件存储。所有集合只保存清洗后的聚合记录（不含任何个人数据）。
 * 生产环境可替换为持久化实现，接口保持不变。
 */
export function createStore(config) {
  return {
    config,
    zones: new Map(), // id -> { id, name, baseCapacity, tags }
    sites: new Map(), // id -> { id, zoneId, kind, name, baseCapacity, status, statusAt }
    operators: new Map(), // id -> { id, zoneId, name }
    devices: new Map(), // id -> { id, zoneId, kind, siteId, expectedIntervalSec, registeredAt }
    seenEvents: new Set(), // 全局 eventId 幂等去重
    flows: [], // 清洗后的流量窗口
    occupancy: new Map(), // operatorId -> 最新一条在店上报
    occupancyHistory: [],
    overrides: new Map(), // eventId -> 阈值调整
    groups: new Map(), // groupKey(按日散列) -> 团体对账记录
    anomalies: [],
    deviceLastWindowEnd: new Map(), // deviceId -> 最近上报窗口结束时间
  };
}

export function hasSeen(store, eventId) {
  return store.seenEvents.has(eventId);
}

export function markSeen(store, eventId) {
  store.seenEvents.add(eventId);
}

export function applyFlow(store, event) {
  store.flows.push(event);
  const prev = store.deviceLastWindowEnd.get(event.deviceId) ?? 0;
  if (event.windowEnd > prev) store.deviceLastWindowEnd.set(event.deviceId, event.windowEnd);
}

/** 在店上报：同一经营者按发生时间最新者为准，历史留痕。 */
export function applyOccupancy(store, rec) {
  const prev = store.occupancy.get(rec.operatorId);
  if (!prev || rec.occurredAt >= prev.occurredAt) store.occupancy.set(rec.operatorId, rec);
  store.occupancyHistory.push(rec);
}

export function applyOverride(store, override) {
  store.overrides.set(override.id, override);
}

export function cancelOverride(store, id, now) {
  const override = store.overrides.get(id);
  if (!override) return false;
  override.endsAt = Math.min(override.endsAt, now);
  return true;
}

/** 生效窗口内可能有多个调整，取最严格（最小系数）。 */
export function activeOverrideFactor(store, targetType, targetId, now) {
  let factor = 1;
  for (const override of store.overrides.values()) {
    if (
      override.targetType === targetType &&
      override.targetId === targetId &&
      override.startsAt <= now &&
      now < override.endsAt
    ) {
      factor = Math.min(factor, override.factor);
    }
  }
  return factor;
}

/** 点位状态按生效时间最新者为准，迟到的旧状态不会覆盖新状态。 */
export function applySiteStatus(store, siteId, status, at) {
  const site = store.sites.get(siteId);
  if (!site) return false;
  if (site.statusAt == null || at >= site.statusAt) {
    site.status = status;
    site.statusAt = at;
  }
  return true;
}

export function applyGroupBooking(store, groupKey, booking) {
  const prev = store.groups.get(groupKey);
  store.groups.set(groupKey, {
    groupKey,
    zoneId: booking.zoneId,
    day: booking.day,
    expectedSize: booking.expectedSize,
    operatorId: booking.operatorId ?? null,
    whole: prev?.whole ?? null,
    parts: prev?.parts ?? new Map(),
    anomalies: prev?.anomalies ?? [],
  });
}

/**
 * 团体到园对账：
 * - 整团（whole）与分批（part）可能都上报（团体拆分场景），
 *   有效人数取两者的较大者，避免整团+分批被重复计入；
 * - 分批按 partId 判重，同一批重复上报不会重复计数；
 * - 有效人数超过预约规模时记录异常，但不丢弃数据。
 */
export function applyGroupArrival(store, groupKey, arrival) {
  let group = store.groups.get(groupKey);
  if (!group) {
    group = {
      groupKey,
      zoneId: arrival.zoneId,
      day: arrival.day,
      expectedSize: null,
      operatorId: null,
      whole: null,
      parts: new Map(),
      anomalies: ['unbooked_group'],
    };
    store.groups.set(groupKey, group);
    store.anomalies.push({ type: 'unbooked_group', groupKey, at: arrival.occurredAt });
  }
  if (arrival.kind === 'whole') {
    if (!group.whole || arrival.occurredAt >= group.whole.occurredAt) {
      group.whole = { count: arrival.count, occurredAt: arrival.occurredAt, eventId: arrival.eventId };
    }
  } else {
    if (group.parts.has(arrival.partId)) {
      const tag = `duplicate_part:${arrival.partId}`;
      if (!group.anomalies.includes(tag)) group.anomalies.push(tag);
      return 'duplicate_part';
    }
    group.parts.set(arrival.partId, {
      count: arrival.count,
      occurredAt: arrival.occurredAt,
      eventId: arrival.eventId,
    });
  }
  const effective = effectiveGroupCount(group, Number.POSITIVE_INFINITY);
  if (group.expectedSize != null && effective > group.expectedSize) {
    const tag = `over_expected:${effective}>${group.expectedSize}`;
    if (!group.anomalies.includes(tag)) {
      group.anomalies.push(tag);
      store.anomalies.push({ type: 'over_expected', groupKey, effective, expected: group.expectedSize });
    }
  }
  return 'applied';
}

/** 截至 now 的团体有效人数：整团数与已发生分批合计的较大者。 */
export function effectiveGroupCount(group, now) {
  const whole = group.whole && group.whole.occurredAt <= now ? group.whole.count : 0;
  let parts = 0;
  for (const part of group.parts.values()) {
    if (part.occurredAt <= now) parts += part.count;
  }
  return Math.max(whole, parts);
}

/** 分区当前在园人数：当日已结束窗口的入口净流量 + 团体对账人数，迟到数据按发生窗口归入。 */
export function visitorsNow(store, zoneId, now) {
  const tz = store.config.tzOffsetMinutes;
  const day = dayKeyOf(now, tz);
  let total = 0;
  for (const flow of store.flows) {
    if (flow.zoneId !== zoneId || flow.siteId) continue;
    if (flow.windowEnd > now) continue;
    if (dayKeyOf(flow.windowEnd, tz) !== day) continue;
    total += flow.entries - flow.exits;
  }
  for (const group of store.groups.values()) {
    if (group.zoneId !== zoneId || group.day !== day) continue;
    total += effectiveGroupCount(group, now);
  }
  return Math.max(0, total);
}

/** 点位（步道/水源点）当前人数，只统计带 siteId 的窗口，不与入口流量混算。 */
export function siteVisitorsNow(store, siteId, now) {
  const tz = store.config.tzOffsetMinutes;
  const day = dayKeyOf(now, tz);
  let total = 0;
  for (const flow of store.flows) {
    if (flow.siteId !== siteId) continue;
    if (flow.windowEnd > now) continue;
    if (dayKeyOf(flow.windowEnd, tz) !== day) continue;
    total += flow.entries - flow.exits;
  }
  return Math.max(0, total);
}

/** 分区当日在店人数合计（跨日的陈旧上报不计入）。 */
export function inHouseTotal(store, zoneId, now) {
  const tz = store.config.tzOffsetMinutes;
  const day = dayKeyOf(now, tz);
  let total = 0;
  for (const [operatorId, rec] of store.occupancy) {
    const operator = store.operators.get(operatorId);
    if (!operator || operator.zoneId !== zoneId) continue;
    if (dayKeyOf(rec.occurredAt, tz) !== day) continue;
    total += rec.inHouse;
  }
  return total;
}

export function snapshotStore(store) {
  return {
    zones: [...store.zones.values()],
    sites: [...store.sites.values()],
    operators: [...store.operators.values()],
    devices: [...store.devices.values()],
    flows: store.flows,
    occupancy: [...store.occupancy.values()],
    overrides: [...store.overrides.values()],
    groups: [...store.groups.values()].map((group) => ({ ...group, parts: [...group.parts.values()] })),
    anomalies: store.anomalies,
    deviceLastWindowEnd: Object.fromEntries(store.deviceLastWindowEnd),
  };
}
