import { createEngine } from './engine.mjs';

/**
 * 国庆前联合演练（2026-09-26，国庆前最后一个周末）：
 * 管理方联合多家住宿经营者，关闭一条热门步道，并注入两批晚到客流
 * （设备离线后的补报、拆分进入的团体），检验分区压力、经营提示与隐私边界。
 *
 * 时间线（UTC+8）：
 *   08:05 在店上报 → 全天预测基线
 *   10:30 降雨，A 区生态阈值临时下调 25%（800→600）
 *   11:00 热门步道 T1 临时封闭
 *   11:00–12:00 入口设备 D_A 离线，窗口数据迟到
 *   12:10 第一批晚到客流：D_A 补报离线时段窗口（重发一次，检验判重）
 *   12:15–12:22 第二批晚到客流：60 人团体先整团上报、后拆分三批上报（检验对账）
 *   15:00 起客流离场，16:00 阈值调整到期，等级应平稳回落、告警解除一次
 */

const DAY = '2026-09-26';
const GROUP_ID = 'GRP-1001';
const T = (hour, minute = 0) =>
  Date.parse(`${DAY}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`);

function split4(n) {
  const base = Math.floor(n / 4);
  const rem = n - base * 4;
  return [0, 1, 2, 3].map((i) => base + (i < rem ? 1 : 0));
}

export function runDrill() {
  const engine = createEngine();
  const checks = [];
  const evalLog = [];
  const summaries = new Map();
  const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

  // ---------- 场景搭建 ----------
  engine.registerZone({ id: 'A', name: '云顶核心区', baseCapacity: 800, tags: ['森林步道', '康养'] });
  engine.registerZone({ id: 'B', name: '溪谷缓冲区', baseCapacity: 600, tags: ['森林步道'] });
  engine.registerZone({ id: 'C', name: '观景台区', baseCapacity: 400, tags: ['观景'] });
  engine.registerSite({ id: 'T1', zoneId: 'A', kind: 'trail', name: '云顶热门步道', baseCapacity: 300 });
  engine.registerSite({ id: 'W1', zoneId: 'A', kind: 'water', name: '冷泉水源点', baseCapacity: 120 });
  engine.registerSite({ id: 'T2', zoneId: 'B', kind: 'trail', name: '溪谷步道', baseCapacity: 250 });
  engine.registerSite({ id: 'T3', zoneId: 'C', kind: 'trail', name: '观景环线', baseCapacity: 200 });
  engine.registerOperator({ id: 'H1', zoneId: 'A', name: '云顶山庄' });
  engine.registerOperator({ id: 'H2', zoneId: 'A', name: '林语民宿' });
  engine.registerOperator({ id: 'H3', zoneId: 'B', name: '溪谷客栈' });
  engine.registerDevice({ id: 'D_A', zoneId: 'A', kind: 'entrance', expectedIntervalSec: 900, registeredAt: T(8) });
  engine.registerDevice({ id: 'D_B', zoneId: 'B', kind: 'entrance', expectedIntervalSec: 900, registeredAt: T(8) });
  engine.registerDevice({ id: 'D_W1', zoneId: 'A', kind: 'site', siteId: 'W1', expectedIntervalSec: 3600, registeredAt: T(8) });

  const postHourly = (deviceId, hourStart, entries, exits, prefix) => {
    const entries4 = split4(entries);
    const exits4 = split4(exits);
    return engine.ingestFlows(
      entries4.map((_, i) => ({
        eventId: `${prefix}-${i}`,
        deviceId,
        windowStart: hourStart + i * 900_000,
        windowEnd: hourStart + (i + 1) * 900_000,
        entries: entries4[i],
        exits: exits4[i],
      })),
    );
  };

  const evaluateAt = (label, ts) => {
    const summary = engine.evaluate(ts);
    summaries.set(label, summary);
    evalLog.push(
      `${label}  ` +
        summary
          .map((s) => `${s.zoneId}:${s.levelName} ${s.visitors}/${s.capacity}${s.degraded ? ' [设备离线]' : ''}`)
          .join('  '),
    );
    return summary;
  };
  const zoneSummary = (label, zoneId) => summaries.get(label).find((s) => s.zoneId === zoneId);

  // ---------- 上午：正常客流 ----------
  engine.ingestOccupancy([
    { eventId: 'occ-h1', operatorId: 'H1', inHouse: 150, occurredAt: T(8) },
    { eventId: 'occ-h2', operatorId: 'H2', inHouse: 100, occurredAt: T(8) },
    { eventId: 'occ-h3', operatorId: 'H3', inHouse: 80, occurredAt: T(8) },
  ]);
  evaluateAt('08:05', T(8, 5));
  engine.ingestGroupBookings(
    [{ eventId: 'bk-g1', groupId: GROUP_ID, zoneId: 'A', expectedSize: 60, forDate: DAY }],
    T(8, 30),
  );
  postHourly('D_A', T(8), 200, 20, 'a08');
  postHourly('D_B', T(8), 130, 0, 'b08');
  evaluateAt('09:05', T(9, 5));
  postHourly('D_A', T(9), 240, 20, 'a09');
  postHourly('D_B', T(9), 100, 0, 'b09');
  evaluateAt('10:05', T(10, 5));

  // ---------- 降雨：阈值临时下调；水源点小计数（检验 k-匿名） ----------
  engine.ingestOverrides([
    {
      eventId: 'ov-rain',
      targetType: 'zone',
      targetId: 'A',
      factor: 0.75,
      startsAt: T(10, 30),
      endsAt: T(16, 0),
      reason: '降雨，生态阈值临时下调',
    },
  ]);
  engine.ingestFlows([
    { eventId: 'w1-1030', deviceId: 'D_W1', siteId: 'W1', windowStart: T(10, 15), windowEnd: T(10, 30), entries: 3, exits: 0 },
  ]);
  postHourly('D_A', T(10), 160, 10, 'a10');
  postHourly('D_B', T(10), 30, 0, 'b10');
  evaluateAt('10:35', T(10, 35)); // 预测驱动：挂起「预警」
  evaluateAt('10:50', T(10, 50)); // 连续确认 → A 升「预警」，告警开启

  // ---------- 热门步道临时封闭 ----------
  engine.ingestSiteStatuses([{ eventId: 'st-t1', siteId: 'T1', status: 'closed', effectiveAt: T(11) }], T(11));
  postHourly('D_B', T(11), 20, 0, 'b11');
  evaluateAt('11:05', T(11, 5));

  // ---------- D_A 离线：11:00–12:00 窗口迟到 ----------
  evaluateAt('12:05', T(12, 5)); // 应标记设备离线（degraded）

  // 第一批晚到客流：设备恢复后补报，且重发一次
  const backfill = split4(190).map((_, i) => ({
    eventId: `bf-${i}`,
    deviceId: 'D_A',
    windowStart: T(11) + i * 900_000,
    windowEnd: T(11) + (i + 1) * 900_000,
    entries: split4(190)[i],
    exits: split4(10)[i],
  }));
  engine.ingestFlows(backfill);
  const backfillRetry = engine.ingestFlows(backfill);
  evaluateAt('12:10', T(12, 10)); // 实测超载 → 快速升「限流」

  // 第二批晚到客流：60 人团体先整团上报，随后拆分三批上报，其中一批重发
  engine.ingestGroupArrivals([{ eventId: 'ga-w1', groupId: GROUP_ID, kind: 'whole', count: 60, occurredAt: T(11, 50) }]);
  evaluateAt('12:15', T(12, 15));
  engine.ingestGroupArrivals([
    { eventId: 'ga-p1', groupId: GROUP_ID, kind: 'part', partId: 'p1', count: 20, occurredAt: T(11, 50) },
    { eventId: 'ga-p2', groupId: GROUP_ID, kind: 'part', partId: 'p2', count: 20, occurredAt: T(11, 55) },
    { eventId: 'ga-p3', groupId: GROUP_ID, kind: 'part', partId: 'p3', count: 20, occurredAt: T(12, 0) },
  ]);
  const partRetry = engine.ingestGroupArrivals([
    { eventId: 'ga-p2', groupId: GROUP_ID, kind: 'part', partId: 'p2', count: 20, occurredAt: T(11, 55) },
  ]);
  evaluateAt('12:25', T(12, 25));
  const zoneStatus1225 = engine.zoneStatus('A', T(12, 25)); // 评估时刻快照，供 k-匿名检查

  // ---------- 午后：高峰维持 ----------
  postHourly('D_A', T(12), 50, 10, 'a12');
  postHourly('D_B', T(12), 10, 0, 'b12');
  evaluateAt('13:05', T(13, 5));
  const promptsAt1305 = {
    h1: engine.promptsFor('H1'),
    h2: engine.promptsFor('H2'),
    h3: engine.promptsFor('H3'),
  };
  postHourly('D_A', T(13), 30, 10, 'a13');
  postHourly('D_B', T(13), 0, 0, 'b13');
  engine.ingestOccupancy([{ eventId: 'occ-h1-2', operatorId: 'H1', inHouse: 180, occurredAt: T(14) }]);
  evaluateAt('14:05', T(14, 5));
  postHourly('D_A', T(14), 10, 60, 'a14');
  postHourly('D_B', T(14), 0, 20, 'b14');
  evaluateAt('15:05', T(15, 5));

  // ---------- 回落：客流离场 + 阈值到期，等级平稳解除 ----------
  postHourly('D_A', T(15), 20, 320, 'a15');
  postHourly('D_B', T(15), 0, 40, 'b15');
  evaluateAt('16:05', T(16, 5)); // 阈值调整已到期，回落确认中
  evaluateAt('16:20', T(16, 20)); // 连续确认 → 解除，告警关闭
  postHourly('D_A', T(16), 10, 260, 'a16');
  postHourly('D_B', T(16), 0, 60, 'b16');
  evaluateAt('17:05', T(17, 5));
  postHourly('D_A', T(17), 0, 200, 'a17');
  postHourly('D_B', T(17), 0, 40, 'b17');
  evaluateAt('18:05', T(18, 5));

  // ---------- 检查项 ----------
  const transitionsA = engine.transitions().filter((t) => t.zoneId === 'A');
  const transitionsOther = engine.transitions().filter((t) => t.zoneId !== 'A');
  const alerts = engine.listAlerts();
  const advisoriesA = engine.listAdvisories('A');

  check(
    '迟到补报判重：离线窗口补报只计一次',
    zoneSummary('12:10', 'A').visitors === 730 && backfillRetry.duplicates.length === 4,
    `12:10 在园 ${zoneSummary('12:10', 'A').visitors}（期望 730），重发判重 ${backfillRetry.duplicates.length}/4`,
  );
  check(
    '团体拆分对账：整团+分批不重复计数',
    zoneSummary('12:25', 'A').visitors === 790 && partRetry.duplicates.includes('ga-p2'),
    `12:25 在园 ${zoneSummary('12:25', 'A').visitors}（期望 790，团体 60 人只计一次）`,
  );
  check(
    '设备离线标记与恢复',
    zoneSummary('12:05', 'A').degraded === true &&
      zoneSummary('12:05', 'A').offlineDevices.includes('D_A') &&
      zoneSummary('12:10', 'A').degraded === false,
    `12:05 离线设备 [${zoneSummary('12:05', 'A').offlineDevices}]，补报后恢复`,
  );
  check(
    '分级升级且无反复跳变',
    transitionsA.length === 3 &&
      transitionsA[0].to === 2 &&
      transitionsA[1].to === 3 &&
      transitionsA[2].to === 0 &&
      transitionsOther.length === 0,
    `A 区等级切换 ${transitionsA.length} 次：预警(10:50) → 限流(12:10) → 正常(16:20)`,
  );
  check(
    '告警生命周期：开启一次、升级留痕、解除一次',
    alerts.length === 1 &&
      alerts[0].zoneId === 'A' &&
      alerts[0].history.map((h) => h.level).join(',') === '2,3' &&
      alerts[0].resolvedAt === T(16, 20),
    `告警 ${alerts[0]?.id} 于 ${new Date(alerts[0]?.openedAt).toISOString()} 开启，${alerts[0]?.resolvedAt ? '已解除' : '未解除'}`,
  );
  check(
    '经营建议：分级发布且冷却期内不重复',
    advisoriesA.length === 2 &&
      advisoriesA[0].level === 2 &&
      advisoriesA[1].level === 3 &&
      advisoriesA[1].alternatives.map((a) => a.zoneId).join(',') === 'B,C' &&
      advisoriesA.every((a) => a.resolvedAt != null),
    `发布 ${advisoriesA.length} 条（预警、限流），限流建议分流至 ${advisoriesA[1]?.alternatives.map((a) => a.zoneId).join('、')}`,
  );
  check(
    '经营者提示：本区限流指令 + 分流目的地接待准备',
    promptsAt1305.h1.some((p) => p.kind === 'restriction') &&
      promptsAt1305.h2.some((p) => p.kind === 'restriction') &&
      promptsAt1305.h3.some((p) => p.kind === 'diversion_incoming') &&
      engine.promptsFor('H1').length === 0,
    'H1/H2 收到限流提示，H3（替代区）收到分流准备提示；解除后提示清空',
  );
  check(
    '阈值临时下调生效并到期恢复',
    zoneSummary('11:05', 'A').capacity === 600 && zoneSummary('16:20', 'A').capacity === 800,
    `A 区容量 800 → 降雨期 ${zoneSummary('11:05', 'A').capacity} → 到期恢复 ${zoneSummary('16:20', 'A').capacity}`,
  );
  check(
    '步道封闭可见且进入建议',
    engine.zoneStatus('A', T(12, 5)).sites.find((s) => s.siteId === 'T1')?.status === 'closed' &&
      advisoriesA[1]?.actions.some((a) => a.includes('封闭')),
    'T1 状态为 closed，限流建议包含绕行提示',
  );
  check(
    '预测预警：在店客流预测提前推高等级',
    zoneSummary('10:35', 'A').pendingLevel === 2 &&
      zoneSummary('10:35', 'A').level === 0 &&
      zoneSummary('10:35', 'A').zoneRatio < 0.85,
    `10:35 实测比 ${zoneSummary('10:35', 'A').zoneRatio}（未越线），预测已挂起「预警」`,
  );
  const privacyReport = engine.privacyReport();
  const rawGroupLeaked = JSON.stringify(engine.snapshot()).includes(GROUP_ID);
  check(
    '隐私边界：无个人字段、团体标识不落盘',
    privacyReport.ok && !rawGroupLeaked,
    `存储扫描${privacyReport.ok ? '通过' : `发现 ${privacyReport.violations.join('; ')}`}，原始团体号${rawGroupLeaked ? '泄漏' : '未出现'}`,
  );
  const w1 = zoneStatus1225.sites.find((s) => s.siteId === 'W1');
  check(
    'k-匿名：小计数对外抑制',
    w1?.visitorsSuppressed === true && w1?.visitors === null && zoneStatus1225.visitors === 790,
    `水源点 3 人（<5）已抑制，分区总量 790 正常发布`,
  );
  check(
    '终态一致：全天计数闭合',
    engine.visitorsNow('A', T(17, 5)) === 250 &&
      engine.visitorsNow('A', T(18, 5)) === 50 &&
      engine.levelOf('A') === 0,
    `17:05 在园 ${engine.visitorsNow('A', T(17, 5))}，18:05 在园 ${engine.visitorsNow('A', T(18, 5))}，等级正常`,
  );

  return { ok: checks.every((c) => c.ok), checks, evalLog };
}
