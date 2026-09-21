// 内存态数据存储：version 单调递增，所有对外结果携带 data_version 以便追溯数据版本
export function createStore() {
  return {
    version: 0,
    zones: new Map(), // zone_id -> { zone_id, name, base_limit }
    trails: new Map(), // trail_id -> { trail_id, zone_id, name, status, reason, updated_ms }
    counters: new Map(), // counter_id -> { counter_id, zone_id, last_heartbeat_ms }
    stayReports: new Map(), // report_id -> 住宿在店上报（幂等键）
    stayByHotelDay: new Map(), // `${hotel_id}|${stay_day}` -> 最新 report_id
    groupPortions: new Map(), // `${group_hash}|${hotel_id}|${stay_day}` -> 团体分量（按日哈希去重）
    entranceBatches: new Map(), // batch_id -> 入口计数批次（幂等键）
    thresholdOverrides: new Map(), // override_id -> 阈值临时调整（幂等键）
    zoneState: new Map(), // zone_id -> { level, since_ms, pending }
    notifications: [], // 已向经营者发布的通知（仅在等级迁移时产生，天然去重）
    noticeSeq: 0,
    audit: [], // 变更日志：{ version, kind, ref, at }
  };
}

export function bump(store, kind, ref, atMs) {
  store.version += 1;
  store.audit.push({ version: store.version, kind, ref, at: new Date(atMs).toISOString() });
  return store.version;
}
