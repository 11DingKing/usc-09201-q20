import { LEVEL_NAMES } from './config.mjs';

/**
 * 替代分区选择：等级不超过「关注」、容量余量充足、仍有开放点位；
 * 优先推荐与当前分区特色（tags）相近的，其次按余量排序。取前 2 个。
 */
export function selectAlternatives(metricsView, selfZoneId, config) {
  const self = metricsView.get(selfZoneId);
  const selfTags = new Set(self?.tags ?? []);
  const candidates = [];
  for (const [zoneId, m] of metricsView) {
    if (zoneId === selfZoneId) continue;
    if (m.level > 1) continue;
    if (!m.hasOpenSites) continue;
    const spareRatio = m.capacity > 0 ? 1 - m.visitors / m.capacity : 0;
    if (spareRatio < config.alternativeMinSpareRatio) continue;
    const shared = m.tags.filter((tag) => selfTags.has(tag)).length;
    candidates.push({
      zoneId,
      name: m.name,
      shared,
      spareRatio,
      spareCapacity: Math.max(0, m.capacity - m.visitors),
    });
  }
  candidates.sort(
    (a, b) => b.shared - a.shared || b.spareRatio - a.spareRatio || a.zoneId.localeCompare(b.zoneId),
  );
  return candidates.slice(0, 2);
}

/** 按等级生成分层行动建议，叠加点位封闭与分流信息。 */
export function buildActions({ level, closedSites, alternatives }) {
  const actions = [];
  if (level >= 1) actions.push('关注客流变化，提醒在店客人错峰出行');
  if (level >= 2) {
    actions.push('暂停新增现场售票与散客入园引导');
    actions.push('建议客人错峰 30–60 分钟进入热门区域');
  }
  if (level >= 3) {
    actions.push('立即停止新增接待并配合限流，住宿经营者暂停当日无预约入住');
  }
  for (const site of closedSites) {
    actions.push(`${site.name} 已临时封闭，请引导游客绕行替代线路`);
  }
  if (level >= 2 && alternatives.length > 0) {
    const text = alternatives.map((a) => `${a.name}（剩余容量约 ${a.spareCapacity} 人）`).join('、');
    actions.push(`建议分流至 ${text}`);
  }
  return actions;
}

/** 建议内容键：分区+等级+替代集合。冷却期内相同键不重复发布，避免对经营者反复打扰。 */
export function advisoryKey(zoneId, level, alternatives) {
  return `${zoneId}|L${level}|${alternatives.map((a) => a.zoneId).join(',')}`;
}

export { LEVEL_NAMES };
