# HTTP 接口

所有请求与响应均为 JSON（UTF-8）。时间字段接受 ISO 8601 字符串或毫秒时间戳。
错误格式：`{ "error": "<code>", "message": "...", "details": [...]? }`。
携带个人数据字段的负载一律 `422 person_data_rejected`（见 [privacy.md](privacy.md)）。

## 管理端（幂等 upsert）

| 方法 | 路径 | 主体 |
| --- | --- | --- |
| PUT | `/v1/admin/zones/:id` | `{ name, baseCapacity, tags? }` |
| PUT | `/v1/admin/sites/:id` | `{ zoneId, kind: trail\|water, name, baseCapacity }` |
| PUT | `/v1/admin/operators/:id` | `{ zoneId, name }` |
| PUT | `/v1/admin/devices/:id` | `{ zoneId, kind: entrance\|site, siteId?, expectedIntervalSec? }` |

## 数据接入

批量接口返回 `{ applied, duplicates, rejected }`：重复 eventId 进入 `duplicates`，单条校验失败进入 `rejected`（含原因），不影响整批其余数据。

| 方法 | 路径 | 主体 |
| --- | --- | --- |
| POST | `/v1/occupancy` | `{ reports: [{ eventId, operatorId, inHouse, occurredAt }] }` |
| POST | `/v1/flows` | `{ events: [{ eventId, deviceId, siteId?, windowStart, windowEnd, entries, exits }] }` |
| POST | `/v1/sites/status` | `{ eventId, siteId, status: open\|closed, effectiveAt? }` |
| POST | `/v1/overrides` | `{ eventId, targetType: zone\|site, targetId, factor: (0,1], startsAt, endsAt, reason? }` |
| DELETE | `/v1/overrides/:id` | 提前终止阈值调整 |
| POST | `/v1/groups/bookings` | `{ eventId, groupId, zoneId, expectedSize, forDate?, operatorId? }` |
| POST | `/v1/groups/arrivals` | `{ events: [{ eventId, groupId, kind: whole\|part, partId?, count, occurredAt, zoneId? }] }`（未预约团体须带 `zoneId`） |
| POST | `/v1/evaluate` | `{ at? }` 按指定时刻触发一次全量评估 |

## 发布视图（均支持 `?at=` 时间回溯）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/zones` | 各分区等级、压力比、在园人数、degraded 标记 |
| GET | `/v1/zones/:id` | 分区详情：点位状态（小计数已抑制）、当前建议 |
| GET | `/v1/alerts` | 告警列表（开启/升级留痕/解除） |
| GET | `/v1/advisories?zoneId=` | 经营建议（含替代分区与行动清单） |
| GET | `/v1/operators/:id/prompts` | 经营者提示：本区等级行动 + 分流目的地接待准备 |
| GET | `/v1/privacy/report` | 隐私自检：存储扫描与团体标识散列检查 |
| GET | `/health` | 健康检查 |
