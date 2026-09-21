import { dayKey, round4 } from './util.mjs';

// 分区有效阈值：基础阈值与窗口期内的临时下调取最小值，过期自动恢复
export function effectiveLimit(store, zoneId, nowMs) {
  const zone = store.zones.get(zoneId);
  if (!zone) return null;
  let limit = zone.base_limit;
  const activeOverrides = [];
  for (const override of store.thresholdOverrides.values()) {
    if (override.zone_id !== zoneId) continue;
    if (override.starts_ms <= nowMs && nowMs < override.ends_ms) {
      activeOverrides.push({
        override_id: override.override_id,
        limit: override.limit,
        reason: override.reason,
        ends_at: new Date(override.ends_ms).toISOString(),
      });
      limit = Math.min(limit, override.limit);
    }
  }
  return { base: zone.base_limit, limit, activeOverrides };
}

// 分区实时压力 = (在店住宿 − 团体重复申报扣减) + 当日净入园，再比上有效阈值。
// 入口批次按“发生时间”归属营业日，迟到数据补入其发生日，不重复计入到达日。
export function computePressure(store, config, zoneId, nowMs) {
  const zone = store.zones.get(zoneId);
  if (!zone) return null;
  const day = dayKey(nowMs, config.tzOffsetMinutes);

  let inHouse = 0;
  let stayReportCount = 0;
  for (const report of store.stayReports.values()) {
    if (report.zone_id !== zoneId || report.stay_day !== day || report.superseded) continue;
    inHouse += report.guests;
    stayReportCount += 1;
  }

  // 团体拆分去重：同一团体（按日哈希）跨店分量求和，超出申报总量的部分视为重复申报，
  // 按各区分量占比扣减，保证拆分入住不会抬高分区负荷
  const groupTotals = new Map();
  for (const portion of store.groupPortions.values()) {
    if (portion.stay_day !== day) continue;
    const entry = groupTotals.get(portion.group_hash) ?? { sum: 0, declared: 0, zones: new Map() };
    entry.sum += portion.members;
    entry.declared = Math.max(entry.declared, portion.declared_total);
    entry.zones.set(portion.zone_id, (entry.zones.get(portion.zone_id) ?? 0) + portion.members);
    groupTotals.set(portion.group_hash, entry);
  }
  let groupExcess = 0;
  const groupWarnings = [];
  for (const [hash, entry] of groupTotals) {
    if (entry.sum <= entry.declared) continue;
    const excess = entry.sum - entry.declared;
    const zoneSum = entry.zones.get(zoneId) ?? 0;
    groupExcess += (excess * zoneSum) / entry.sum;
    groupWarnings.push({ group_ref: hash.slice(0, 12), declared: entry.declared, reported: entry.sum });
  }
  groupExcess = Math.round(groupExcess);

  let dayVisitors = 0;
  let batchCount = 0;
  let lateBatches = 0;
  for (const batch of store.entranceBatches.values()) {
    if (batch.zone_id !== zoneId) continue;
    if (dayKey(batch.occurred_ms, config.tzOffsetMinutes) !== day) continue;
    dayVisitors += batch.entered - batch.exited;
    batchCount += 1;
    if (batch.arrived_ms - batch.occurred_ms > config.lateBatchThresholdMs) lateBatches += 1;
  }
  dayVisitors = Math.max(0, dayVisitors);

  const inHouseNet = Math.max(0, inHouse - groupExcess);
  const total = inHouseNet + dayVisitors;
  const limits = effectiveLimit(store, zoneId, nowMs);
  const ratio = limits.limit > 0 ? total / limits.limit : total > 0 ? Number.POSITIVE_INFINITY : 0;

  const offlineCounters = [];
  for (const counter of store.counters.values()) {
    if (counter.zone_id !== zoneId) continue;
    if (nowMs - counter.last_heartbeat_ms > config.counterHeartbeatTtlMs) {
      offlineCounters.push(counter.counter_id);
    }
  }

  return {
    zone_id: zoneId,
    day,
    load: {
      in_house: inHouseNet,
      day_visitors: dayVisitors,
      group_excess_deducted: groupExcess,
      total,
    },
    limit: { base: limits.base, effective: limits.limit, overrides: limits.activeOverrides },
    ratio: round4(ratio),
    data_quality: {
      degraded: offlineCounters.length > 0 || groupWarnings.length > 0,
      offline_counters: offlineCounters,
      late_batches: lateBatches,
      group_warnings: groupWarnings,
    },
    inputs: { stay_reports: stayReportCount, entrance_batches: batchCount },
  };
}
