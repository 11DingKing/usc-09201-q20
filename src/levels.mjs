// 分区等级状态机：升级立即生效（安全优先），降级需跌破退出线且满足最短驻留，
// 使比率在阈值附近小幅波动时等级保持稳定，避免对经营者的通知反复跳变。
export const LEVEL_OK = 0;

const OK_META = { code: 0, name: '正常', color: 'green' };

export function levelMeta(config, code) {
  if (code === LEVEL_OK) return OK_META;
  const meta = config.levels.find((level) => level.code === code);
  if (!meta) throw new Error(`未知等级 ${code}`);
  return meta;
}

export function evaluateLevel({ ratio, current, lastChangeMs, nowMs, config }) {
  const maxLevel = config.levels.length;
  let target = current;
  while (target < maxLevel && ratio >= config.levels[target].enter) {
    target += 1;
  }
  if (target > current) {
    return { level: target, changed: true, reason: 'escalate' };
  }
  let desired = current;
  while (desired > 0 && ratio < config.levels[desired - 1].exit) {
    desired -= 1;
  }
  if (desired < current) {
    if (nowMs - lastChangeMs >= config.minDwellMs) {
      return { level: desired, changed: true, reason: 'downgrade' };
    }
    return { level: current, changed: false, reason: 'dwell', pending: desired };
  }
  return { level: current, changed: false, reason: 'hold' };
}
