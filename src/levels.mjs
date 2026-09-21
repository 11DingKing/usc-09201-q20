/**
 * 分区等级状态机：进入/退出双阈值 + 连续确认，红色等级快速升级。
 * 目标等级必须连续出现足够次数才会真正切换，从而避免边界附近的反复跳变。
 */

function highestLevelAtOrAbove(ratio, bands, key) {
  let level = 0;
  for (const band of bands) {
    if (ratio >= band[key]) level = Math.max(level, band.level);
  }
  return level;
}

/**
 * 由实测/预测压力比计算目标等级。
 * 预测分量被限制在 forecastMaxLevel（预警）以内：限流只能由实测触发。
 */
export function desiredLevel(currentRatio, forecastRatio, currentLevel, config) {
  const cap = config.forecastMaxLevel;
  const escCurrent = highestLevelAtOrAbove(currentRatio, config.bands, 'enter');
  const escForecast = Math.min(highestLevelAtOrAbove(forecastRatio, config.bands, 'enter'), cap);
  const escalateTo = Math.max(escCurrent, escForecast);
  if (escalateTo > currentLevel) return escalateTo;

  const deCurrent = highestLevelAtOrAbove(currentRatio, config.bands, 'exit');
  const deForecast = Math.min(highestLevelAtOrAbove(forecastRatio, config.bands, 'exit'), cap);
  const deescalateTo = Math.max(deCurrent, deForecast);
  if (deescalateTo < currentLevel) return deescalateTo;

  return currentLevel;
}

export function createLevelState() {
  return { level: 0, pendingLevel: 0, pendingCount: 0, lastChangeAt: null };
}

/**
 * 推进一步。目标等级与当前相同则清空挂起计数；目标变化则重新计数。
 * 返回是否发生了确认的等级切换。
 */
export function stepLevel(state, desired, now, config) {
  if (desired === state.level) {
    state.pendingLevel = desired;
    state.pendingCount = 0;
    return false;
  }
  const needed =
    desired > state.level
      ? desired >= config.fastEscalateLevel
        ? 1
        : config.escalateAfter
      : config.deescalateAfter;
  if (state.pendingLevel === desired) {
    state.pendingCount += 1;
  } else {
    state.pendingLevel = desired;
    state.pendingCount = 1;
  }
  if (state.pendingCount >= needed) {
    state.level = desired;
    state.pendingCount = 0;
    state.lastChangeAt = now;
    return true;
  }
  return false;
}
