import { levelMeta } from './levels.mjs';

// 告警生命周期：仅在等级真正迁移时产生一条通知（发布/升级/降级/解除），
// 等级未变时不重复推送；滞回与驻留由等级状态机保证，因此解除不会反复。
export function applyLevelTransition(store, config, zoneId, evaluated, nowMs, pressure) {
  const state = store.zoneState.get(zoneId) ?? { level: 0, since_ms: nowMs };
  const previous = state.level;
  state.level = evaluated.level;
  state.pending = evaluated.pending ?? null;
  if (evaluated.changed) state.since_ms = nowMs;
  store.zoneState.set(zoneId, state);
  if (!evaluated.changed) return null;

  const type = previous === 0 && evaluated.level > 0 ? 'issued'
    : evaluated.level === 0 ? 'resolved'
    : evaluated.level > previous ? 'escalated'
    : 'downgraded';
  const zone = store.zones.get(zoneId);
  const zoneName = zone?.name ?? zoneId;
  const toMeta = levelMeta(config, evaluated.level);
  store.noticeSeq += 1;
  const notice = {
    notice_id: `ntf_${store.noticeSeq}`,
    type,
    zone_id: zoneId,
    zone_name: zoneName,
    from_level: previous,
    to_level: evaluated.level,
    to_level_name: toMeta.name,
    ratio: pressure ? pressure.ratio : null,
    at: new Date(nowMs).toISOString(),
    message: buildMessage(type, zoneName, toMeta),
  };
  store.notifications.push(notice);
  return notice;
}

function buildMessage(type, zoneName, toMeta) {
  switch (type) {
    case 'issued': return `${zoneName}进入${toMeta.name}等级，请经营者按建议调整接待节奏`;
    case 'escalated': return `${zoneName}升级为${toMeta.name}等级，请立即执行对应管控措施`;
    case 'downgraded': return `${zoneName}调整为${toMeta.name}等级，可逐步恢复接待`;
    case 'resolved': return `${zoneName}预警解除，恢复正常接待`;
    default: return `${zoneName}等级变更`;
  }
}
