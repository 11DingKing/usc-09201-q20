import { createStore } from './store.mjs';
import { defaultConfig } from './config.mjs';
import { createEngine } from './engine.mjs';
import { seedStore } from './seed.mjs';
import { auditPrivacy } from './privacy.mjs';

const iso = (ms) => new Date(ms).toISOString();

// 国庆前联合演练：在隔离的内存状态上重演
// “关闭热门步道 + 阈值临时下调 + 两批晚到客流 + 设备重试 + 出园回落”，
// 输出分区压力时间线、经营提示、通知序列与隐私边界检查。
export function runDrill() {
  const startMs = Date.parse('2026-09-26T08:00:00+08:00'); // 国庆前周末
  let now = startMs;
  const clock = { nowMs: () => now };
  const config = defaultConfig({ minDwellMs: 5 * 60_000, tokenSalt: 'drill-salt' });
  const store = createStore();
  seedStore(store, now);
  const engine = createEngine({ store, config, clock });

  const timeline = [];
  const record = (step, extra = {}) => {
    const pressure = engine.zonePressure('z-cloud');
    timeline.push({
      step,
      at: iso(now),
      level: pressure.level,
      level_name: pressure.level_name,
      ratio: pressure.ratio,
      load: pressure.load.total,
      effective_limit: pressure.limit.effective,
      ...extra,
    });
  };

  // 1) 早高峰基线：两家酒店在店 380（含同一团体 GRP-001 拆分 40+50），净入园 160
  engine.ingestStay({
    report_id: 'stay-h1-0926', hotel_id: 'h-cloud-1', zone_id: 'z-cloud', stay_date: '2026-09-26',
    guests: 200, groups: [{ token: 'GRP-001', members_at_property: 40, declared_total: 90 }],
  });
  engine.ingestStay({
    report_id: 'stay-h2-0926', hotel_id: 'h-cloud-2', zone_id: 'z-cloud', stay_date: '2026-09-26',
    guests: 180, groups: [{ token: 'GRP-001', members_at_property: 50, declared_total: 90 }],
  });
  engine.ingestEntrance({
    batch_id: 'batch-cn-0830', counter_id: 'c-cloud-n', entered: 180, exited: 20,
    occurred_at: iso(now - 30 * 60_000),
  });
  record('baseline');

  // 2) 酒店修正重报：同住宿日取代旧报告，不得重复计数
  engine.ingestStay({
    report_id: 'stay-h2-0926-fix', hotel_id: 'h-cloud-2', zone_id: 'z-cloud', stay_date: '2026-09-26',
    guests: 180, groups: [{ token: 'GRP-001', members_at_property: 50, declared_total: 90 }],
  });
  record('resend');

  // 3) 降雨：关闭热门步道云顶步道，云杉谷阈值临时下调 800 -> 700
  now += 10 * 60_000;
  engine.setTrailStatus({ trail_id: 't-summit', status: 'closed', reason: '强降雨导致落石风险' });
  engine.setThresholdOverride({
    override_id: 'ovr-rain-0926', zone_id: 'z-cloud', limit: 700,
    starts_at: iso(now), ends_at: iso(now + 6 * 3_600_000), reason: '降雨期安全余量下调',
  });
  record('closure');

  // 4) 两批晚到客流：匿名计数迟到 40 / 25 分钟，按发生时间补账
  now += 20 * 60_000;
  engine.ingestEntrance({
    batch_id: 'batch-late-a', counter_id: 'c-cloud-n', entered: 120, exited: 0,
    occurred_at: iso(now - 40 * 60_000),
  });
  record('late-a');
  now += 5 * 60_000;
  engine.ingestEntrance({
    batch_id: 'batch-late-b', counter_id: 'c-cloud-s', entered: 60, exited: 0,
    occurred_at: iso(now - 25 * 60_000),
  });
  record('late-b');
  const peakAdvisory = engine.advisory('z-cloud');

  // 5) 设备重试重复上报第一批：必须幂等去重
  const replay = engine.ingestEntrance({
    batch_id: 'batch-late-a', counter_id: 'c-cloud-n', entered: 120, exited: 0,
    occurred_at: iso(now - 45 * 60_000),
  });
  record('replay', { deduplicated: replay.duplicated });

  // 6) 出园分流，压力回落，告警降级直至解除
  now += 30 * 60_000;
  engine.ingestEntrance({ batch_id: 'batch-exit-1', counter_id: 'c-cloud-n', entered: 0, exited: 200, occurred_at: iso(now) });
  record('exit-1');
  now += 30 * 60_000;
  engine.ingestEntrance({ batch_id: 'batch-exit-2', counter_id: 'c-cloud-s', entered: 0, exited: 160, occurred_at: iso(now) });
  record('exit-2');

  const privacy = auditPrivacy(store);
  const serialized = JSON.stringify(store, (key, value) => (value instanceof Map ? Object.fromEntries(value) : value));
  const byId = Object.fromEntries(timeline.map((entry) => [entry.step, entry]));
  const checks = [
    { name: '住宿在店按酒店最新上报去重', passed: byId.resend.load === byId.baseline.load },
    { name: '步道关闭且阈值临时下调后进入关注等级', passed: byId.closure.level === 1 },
    { name: '两批晚到客流按发生时间入账并逐级升至管制', passed: byId['late-a'].level === 2 && byId['late-b'].level === 3 },
    { name: '重复批次被幂等去重', passed: replay.duplicated === true && byId.replay.load === byId['late-b'].load },
    { name: '客流回落后告警解除且仅解除一次', passed: byId['exit-2'].level === 0 && store.notifications.filter((n) => n.type === 'resolved').length === 1 },
    { name: '等级序列无反复跳变', passed: noFlap(store.notifications) },
    { name: '管制期间替代建议指向其他开放分区', passed: peakAdvisory.alternatives.length > 0 && peakAdvisory.alternatives.every((a) => a.spare_ratio > 0) },
    { name: '个人轨迹不可还原（无原始凭证与个人标识）', passed: privacy.ok && !serialized.includes('GRP-001') },
  ];
  return {
    scenario: '国庆前联合演练：关闭热门步道并注入两批晚到客流',
    timeline,
    notifications: store.notifications,
    peak_advisory: peakAdvisory,
    privacy,
    checks,
    passed: checks.every((check) => check.passed),
  };
}

// 通知序列中等级一旦开始下降就不允许再回升，否则视为反复跳变
function noFlap(notifications) {
  let wentDown = false;
  for (const notice of notifications) {
    const delta = notice.to_level - notice.from_level;
    if (delta < 0) wentDown = true;
    if (delta > 0 && wentDown) return false;
  }
  return true;
}
