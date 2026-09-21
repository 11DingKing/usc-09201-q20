export const LEVEL_NAMES = { 0: '正常', 1: '关注', 2: '预警', 3: '限流' };

/**
 * 全局默认配置。所有阈值集中在此，演练与单测可通过 createEngine(overrides) 覆盖。
 *
 * bands: 进入/退出双阈值（迟滞带）。等级只有在连续若干次评估都越线后才切换，
 * 防止压力在边界附近小幅波动时等级反复跳变。
 */
export function createConfig(overrides = {}) {
  return {
    tzOffsetMinutes: 480, // 景区时区 UTC+8
    windowSec: 900, // 计数设备上报窗口（15 分钟）
    kAnonymity: 5, // 对外发布的最小计数，低于该值的小计数被抑制
    visitRate: 0.3, // 在店客人当日入园比例（预测系数）
    forecastMaxLevel: 2, // 预测最多只能把等级推到「预警」，「限流」必须由实测触发
    dayOpenHour: 8,
    dayCloseHour: 18,
    bands: [
      { level: 1, enter: 0.7, exit: 0.65 },
      { level: 2, enter: 0.85, exit: 0.8 },
      { level: 3, enter: 1.0, exit: 0.95 },
    ],
    escalateAfter: 2, // 升级需连续确认次数
    deescalateAfter: 2, // 降级需连续确认次数
    fastEscalateLevel: 3, // 达到该等级立即升级（安全优先）
    advisoryCooldownSec: 1800, // 相同内容建议的发布冷却期
    alternativeMinSpareRatio: 0.25, // 替代分区至少需保留的容量余量比例
    deviceOfflineFactor: 1.5, // 超过 上报间隔×该系数 未上报视为离线
    ...overrides,
  };
}
