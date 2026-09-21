# 接口说明

所有接口以 JSON 交互。除 `/health` 外均需携带 `x-role` 请求头；缺少角色返回 `401`，角色无权访问返回 `403`。错误响应统一为：

```json
{ "error": { "code": "bad_request", "message": "……", "details": null } }
```

## 角色一览

| 角色 | 用途 |
| --- | --- |
| `device` | 入口计数设备：上报计数批次、发送心跳 |
| `hotel` | 住宿经营者：上报在店人数与团体分量 |
| `operator` | 经营者：读取分区压力、等级、经营建议、告警 |
| `manager` | 景区管理方：全部接口，含阈值、步道、演练、隐私审计 |

## 数据接入

### `POST /ingest/stay`（hotel / manager）

上报某酒店某住宿日的在店人数。`report_id` 幂等；同酒店同住宿日的新报告取代旧报告。

```json
{
  "report_id": "stay-h1-0926",
  "hotel_id": "h-cloud-1",
  "zone_id": "z-cloud",
  "stay_date": "2026-09-26",
  "guests": 200,
  "groups": [{ "token": "GRP-001", "members_at_property": 40, "declared_total": 90 }]
}
```

- `groups` 可选：团体拆分入住时按分量上报；`token` 只以哈希落库，不落原文。
- 响应：`{ accepted, duplicated, data_version, level, notice }`。

### `POST /ingest/entrance`（device / manager）

上报入口匿名计数批次。`batch_id` 幂等（设备重试安全）；按 `occurred_at` 归属营业日。

```json
{ "batch_id": "batch-cn-0830", "counter_id": "c-cloud-n", "entered": 180, "exited": 20, "occurred_at": "2026-09-26T08:30:00+08:00" }
```

- 响应增加 `late`：到达时间晚于发生时间超过 5 分钟为 `true`。

### `POST /devices/heartbeat`（device / manager）

```json
{ "counter_id": "c-cloud-n", "at": "2026-09-26T08:35:00+08:00" }
```

超过 3 分钟未心跳的设备计入 `data_quality.offline_counters`。

### `POST /ingest/trail-status`（manager）

```json
{ "trail_id": "t-summit", "status": "closed", "reason": "强降雨导致落石风险" }
```

`status` 取值 `open` / `limited` / `closed`。

### `POST /thresholds/override`（manager）

生态阈值临时下调，窗口内生效、到期自动恢复；`override_id` 幂等。

```json
{ "override_id": "ovr-rain-0926", "zone_id": "z-cloud", "limit": 700, "starts_at": "2026-09-26T08:10:00+08:00", "ends_at": "2026-09-26T14:10:00+08:00", "reason": "降雨期安全余量下调" }
```

## 读取（operator / manager）

### `GET /zones`

各分区当前等级、比率与有效阈值。

### `GET /zones/:zoneId/pressure`

分区实时压力：负荷构成（在店、当日净入园、团体扣减）、有效阈值与临时调整、比率、等级、数据质量（离线设备、迟到批次、团体超申报）、`data_version`。

### `GET /zones/:zoneId/advisory`

经营者建议：等级行动清单、替代分区（预警及以上）、封闭步道、数据质量提示。

### `GET /alerts`

当前处于非零等级的分区及最近 100 条通知（发布/升级/降级/解除）。

## 管理（manager）

### `GET /privacy/audit`

扫描全部已存记录，报告个人标识字段或证件号/手机号等违规；`ok: true` 表示通过。

### `POST /drill/run`

在隔离的内存状态上执行国庆前联合演练（关闭热门步道 + 阈值临时下调 + 两批晚到客流 + 设备重试 + 出园回落），返回压力时间线、通知序列、高峰期经营建议、隐私审计与逐项检查结果，`passed: true` 表示演练通过。演练不影响线上状态。
