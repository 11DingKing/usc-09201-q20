// 全局配置：等级阈值采用“进入线 / 退出线”滞回设计，配合最短驻留时间避免等级反复跳变
export function defaultConfig(overrides = {}) {
  return {
    tzOffsetMinutes: 480, // 景区营业日按 UTC+8 划分
    counterHeartbeatTtlMs: 3 * 60_000, // 计数设备超过此时长未心跳视为离线
    lateBatchThresholdMs: 5 * 60_000, // 到达时间晚于发生时间超过此值记为迟到批次
    maxFutureSkewMs: 120_000, // 容忍的设备时钟前倾
    minDwellMs: 10 * 60_000, // 等级下调前必须稳定维持的最短时长
    tokenSalt: process.env.TOKEN_SALT || 'dev-only-salt-change-me',
    levels: [
      { code: 1, name: '关注', color: 'yellow', enter: 0.75, exit: 0.7 },
      { code: 2, name: '预警', color: 'orange', enter: 0.9, exit: 0.85 },
      { code: 3, name: '管制', color: 'red', enter: 1.0, exit: 0.95 },
    ],
    ...overrides,
  };
}
