export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/** 解析 ISO 字符串或毫秒时间戳，非法输入抛错。 */
export function parseTs(value) {
  const ts = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ts)) throw new Error(`无效时间: ${value}`);
  return ts;
}

/** 按景区所在时区（配置为相对 UTC 的偏移分钟）计算自然日键 YYYY-MM-DD。 */
export function dayKeyOf(ts, tzOffsetMinutes) {
  const shifted = new Date(ts + tzOffsetMinutes * MINUTE_MS);
  return shifted.toISOString().slice(0, 10);
}

/** 当日开园/闭园时刻（毫秒时间戳）。 */
export function dayBounds(ts, config) {
  const shifted = new Date(ts + config.tzOffsetMinutes * MINUTE_MS);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const open = midnight + config.dayOpenHour * HOUR_MS - config.tzOffsetMinutes * MINUTE_MS;
  const close = midnight + config.dayCloseHour * HOUR_MS - config.tzOffsetMinutes * MINUTE_MS;
  return { open, close };
}

/** 距闭园的剩余时间占比：开园前为 1，闭园后为 0。用于把在店人数折算成预计入园量。 */
export function remainingFraction(ts, config) {
  const { open, close } = dayBounds(ts, config);
  if (ts <= open) return 1;
  if (ts >= close) return 0;
  return (close - ts) / (close - open);
}
