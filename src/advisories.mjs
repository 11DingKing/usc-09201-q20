import { levelMeta } from './levels.mjs';
import { computePressure } from './pressure.mjs';
import { round4 } from './util.mjs';

// 面向经营者的分区建议：按等级给出行动清单，预警及以上自动推荐低负荷替代分区，
// 并附带封闭步道与数据质量提示，帮助多家经营者协同分流而非各自按房量接客。
const ACTIONS = {
  0: ['正常接待，保持步道与水源点日常巡查'],
  1: ['提醒住店游客错峰出行', '预备分流讲解与替代线路物料', '加密步道与水源点巡查频次'],
  2: ['暂停向本区引导新客，停止散客现场售票', '引导在园游客前往低负荷替代区域', '与周边经营者同步接待节奏，避免集中转送'],
  3: ['停止本区一切新客入园引导，启动单向出园疏导', '暂停新预订转入并协助已在园游客有序离开', '配合管理方执行临时管制与信息通报'],
};

export function buildAdvisory(store, config, zoneId, nowMs) {
  const pressure = computePressure(store, config, zoneId, nowMs);
  if (!pressure) return null;
  const state = store.zoneState.get(zoneId) ?? { level: 0 };
  const meta = levelMeta(config, state.level);
  const closedTrails = [...store.trails.values()]
    .filter((trail) => trail.zone_id === zoneId && trail.status !== 'open')
    .map((trail) => ({ trail_id: trail.trail_id, name: trail.name, status: trail.status, reason: trail.reason ?? null }));
  return {
    zone_id: zoneId,
    level: state.level,
    level_name: meta.name,
    color: meta.color,
    ratio: pressure.ratio,
    actions: ACTIONS[state.level],
    alternatives: state.level >= 2 ? suggestAlternatives(store, config, zoneId, nowMs) : [],
    closed_trails: closedTrails,
    data_quality: pressure.data_quality,
  };
}

function suggestAlternatives(store, config, excludeZoneId, nowMs) {
  const suggestions = [];
  for (const zone of store.zones.values()) {
    if (zone.zone_id === excludeZoneId) continue;
    const pressure = computePressure(store, config, zone.zone_id, nowMs);
    const state = store.zoneState.get(zone.zone_id) ?? { level: 0 };
    if (state.level >= 2) continue; // 自身已高负荷的分区不作为替代去向
    suggestions.push({
      zone_id: zone.zone_id,
      name: zone.name,
      level: state.level,
      spare_ratio: round4(Math.max(0, 1 - pressure.ratio)),
      has_closed_trails: [...store.trails.values()].some(
        (trail) => trail.zone_id === zone.zone_id && trail.status === 'closed',
      ),
    });
  }
  return suggestions.sort((a, b) => b.spare_ratio - a.spare_ratio);
}
