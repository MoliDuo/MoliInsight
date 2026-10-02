# MoliInsight 接收协议 v1

这是平台的核心契约。机器可读的版本是 [`packages/protocol/schema/`](../packages/protocol/schema) 下的 JSON Schema，它们由 [`packages/protocol/src/`](../packages/protocol/src) 里的 Zod 定义生成，那里是唯一来源。本文说明 JSON Schema 表达不了的规则，以及为什么这样规定。

协议是普通的 HTTP 加 JSON。任何能发 HTTP 请求的程序都可以接入，不需要 SDK。

## 1. 接口

| 接口 | 用途 | 鉴权 |
|---|---|---|
| `POST /v1/ingest` | 上报一批事件 | `Authorization: Bearer mi_…`（ingest key，只写） |
| `PUT /v1/catalog` | 上传事件目录，整体替换 | 同上，只能改这个 key 所属的 App |
| `GET /v1/export` | 导出，格式见 [export-v1.md](export-v1.md) | `Authorization: Bearer mia_…`（admin token）或看板登录 |
| `/mcp` | 给 Claude 查询（M4） | admin token |

key 的前缀固定：ingest key 以 `mi_` 开头，admin token 以 `mia_` 开头。这样密钥扫描工具和人都能看出泄露的是什么。服务端只保存 key 的 HMAC，key 本身只在生成时显示一次。

## 2. 请求

```jsonc
POST /v1/ingest
Authorization: Bearer mi_…
Content-Type: application/json
Content-Encoding: gzip        // 可选

{
  "schemaVersion": 1,
  "sentAt": "2026-10-02T08:00:00.000Z",     // 发送这个请求的时刻，不是事件入队的时刻
  "context": { … },                          // 整批共享
  "events": [ … ]                            // 最多 100 条
}
```

### context

整批共享，服务端把它写进 device 和 event。

| 字段 | 必填 | 说明 |
|---|---|---|
| `platform` | 是 | `web`、`ios`、`android`、`windows`、`macos`、`server` |
| `release` | 是 | 应用的版本。网页用部署的 git SHA，原生程序用版本号或 build 号。最长 64 |
| `deviceId` | 否 | `dev_` 加 8–48 位字母数字。服务端事件省略 |
| `deviceClass` | 否 | `phone`、`tablet`、`desktop` |
| `os` | 否 | 粗粒度，例如 `iOS 26`、`macOS 26.0`。不是完整的 User-Agent |
| `client` | 否 | 粗粒度，例如 `Safari 26` |
| `viewport` | 否 | `[宽, 高]` |
| `locale`、`timeZone` | 否 | |
| `standalone` | 否 | 是否以 PWA 或安装后的形式运行 |

不认识的字段会被忽略，不会报错。新增字段就是这样做到向后兼容的。

### event

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 任意版本的 UUID，用于去重。推荐 UUIDv7，但 Swift 和 Kotlin 自带的是 v4，同样可用 |
| `name` | 是 | 见 4.1 |
| `occurredAt` | 是 | ISO 8601，必须带时区偏移（`Z` 或 `+08:00`） |
| `mono` | 否 | 单调时钟的毫秒数，用来精确计算事件间隔，不受系统时钟跳变影响 |
| `sessionId` | 否 | `ses_` 加 8–48 位字母数字。服务端事件省略 |
| `correlationId` | 否 | 最长 64，字母数字和 `_.:-`。把同一个动作的客户端事件和服务端事件串起来 |
| `route` | 否 | 只放路由模板和浮层标记，最长 200。服务端会去掉 query 的值 |
| `props` | 否 | 见 4.2 |

## 3. 限制

所有数字都集中在 [`limits.ts`](../packages/protocol/src/limits.ts)。

| 项 | 限制 |
|---|---|
| 请求体（压缩后，即实际发送的大小） | 64 KB |
| 请求体（解压后） | 512 KB |
| 每批事件数 | 100 |
| 事件名长度 | 64 |
| `props` 嵌套层数 | 3（`props` 本身算第 1 层） |
| `props` 序列化后大小 | 4096 字节（UTF-8，截断字符串之后计算） |
| `props` 里字符串 | 200 个字符，超出截断，不拒绝 |
| `props` 里数组 | 20 项 |
| `props` 的键 | `^[A-Za-z_][A-Za-z0-9_]{0,63}$` |
| `occurredAt` 窗口 | 不晚于接收时间 5 分钟，不早于接收时间 7 天 |

`sendBeacon` 不能设置请求头，所以用它发送时不能压缩，也受浏览器自己 64 KB 的限制。

## 4. 校验与规范化

### 4.1 事件名

`^\$?[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$`，最长 64。

- 应用自定义事件用 `领域.动作`，例如 `record.submit`、`detail.edit`。驼峰也可以，`appStart`、`manualSwitch` 就是驼峰，现有的原生程序不用改名。
- 以 `$` 开头的名称留给 SDK 的标准事件。
- 事件属于哪个 App 由 key 决定，名称里不加应用前缀。

### 4.2 props

`props` 是一个 JSON 对象。值可以是 string、number、boolean、null、数组，或者嵌套的对象，只要符合第 3 节的层数、大小和数组长度限制。

- 键限制成不含点和连字符的形式，这样任何键都能写进 JSON 路径，也能被索引。
- 超长的字符串被截断而不是拒绝，因为丢掉整条事件比丢掉一段文字更糟。
- 超过层数、数组长度、键格式或大小限制的事件被拒绝，原因见第 5 节。

### 4.3 服务端的脱敏

这是兜底，不能替代客户端遵守隐私规则。

- `route`：去掉 query 的值和 `#` 之后的部分。`/records?id=42&new#top` 变成 `/records?id&new`。
- `props` 中键名为 `message` 或 `error` 的字符串：连续 4 位及以上的数字替换成 `#`。短数字（例如 HTTP 状态码 `500`）保留。

注意 4 位错误码（例如 NSError 的 `3840`）也会被替换。需要保留错误码时，放进单独的 `code` 属性，不要拼进 `message`。

### 4.4 时间校正

客户端的时钟可能不准。`sentAt` 是发送这个请求的时刻，所以 `接收时间 − sentAt` 就是这一批的时钟误差（含网络延迟）。

1. `skew = 接收时间 − sentAt`
2. 每个事件：`校正后时间 = occurredAt + skew`
3. 校正后时间超出窗口时，夹到边界：最晚是接收时间加 5 分钟，最早是接收时间减 7 天。

整批平移，所以事件之间的间隔和顺序保持不变。`sentAt` 必须在每次发送（包括重试）时重新取，而不是在事件入队时。

### 4.5 去重

同一个 App 下 `id` 唯一。重复的事件静默忽略，计入响应的 `duplicates`，所以重发是安全的。

## 5. 响应

成功：

```json
{ "accepted": 98, "duplicates": 1, "rejected": [{ "index": 3, "reason": "props_too_large" }] }
```

部分事件不合法时整批不会失败：合法的被接收，不合法的按下标列在 `rejected` 里。

| `reason` | 含义 |
|---|---|
| `invalid_event` | 不是对象，或结构不对 |
| `invalid_id` | 不是 UUID |
| `invalid_name` | 事件名格式不对或太长 |
| `invalid_time` | `occurredAt` 不是带偏移的 ISO 8601 |
| `invalid_mono` | `mono` 不是非负数 |
| `invalid_session` | `sessionId` 格式不对 |
| `invalid_correlation` | `correlationId` 格式不对 |
| `invalid_route` | `route` 太长 |
| `invalid_props` | 键格式不对、数组太长或值不是 JSON |
| `props_too_deep` | 嵌套超过 3 层 |
| `props_too_large` | 序列化后超过 4096 字节 |
| `invalid_standard_props` | 已知的 `$` 事件缺少必需的 props 或类型不对 |

整批失败时返回错误，格式 `{ "error": "<code>", "message"?: "…" }`：

| 状态码 | `error` | 说明 |
|---|---|---|
| 400 | `invalid_json` | 请求体不是 JSON，或声明了 gzip 但内容损坏 |
| 400 | `invalid_envelope` | 缺少或写错 `schemaVersion`、`sentAt`、`context`、`events`，或事件数超过 100 |
| 400 | `unsupported_schema_version` | 服务端不支持这个 `schemaVersion` |
| 401 | `unauthorized` | key 无效或已作废 |
| 413 | `payload_too_large` | 超过第 3 节的请求体限制（发送 64KB、解压后 512KB） |
| 415 | `unsupported_encoding` | `Content-Encoding` 不是 `gzip` 或不带 |
| 429 | `rate_limited` | 超过限额，带 `Retry-After`（秒） |

客户端的处理：401 保留队列等恢复，429 按 `Retry-After` 等待，5xx 和网络错误指数退避，其他 4xx 丢弃这一批（重发也不会成功）。限额的具体数值在 M1 实测后确定，协议只规定 429 和 `Retry-After`。

## 6. 标准事件

以 `$` 开头，由 SDK 产生，看板原生理解。按**配置包**分组，平台只需要实现自己的那个包。

| 包 | 事件 | 说明 |
|---|---|---|
| **core**（所有平台，首个版本发布后冻结） | `$session_start`、`$error` | |
| **web**（Web SDK 自动采集） | `$visibility`、`$screen`、`$tap`、`$rage_tap`、`$dead_tap`、`$vital` | |
| **experimental**（只在一个应用里验证过，v1 内 props 仍可调整） | `$op`、`$dialog`、`$toast` | 第二个应用验证后升入 core 或 web |

props 的定义在 [`standard-events.ts`](../packages/protocol/src/standard-events.ts)，校验是宽松的：必需的键和类型要对，多出来的键一律放行。不认识的 `$` 名称也会被接收，这样较新的 SDK 配较旧的服务端不会丢数据。

后台程序没有页面和点击，用到的标准事件只有 `$session_start` 和 `$error`，其余都是它自己的事件。这是预期的用法：标准事件是通用的下限，不是上限。

## 7. Session

`sessionId` 由客户端生成，协议只要求它不透明且稳定。每个平台的规则不同：

- **Web**：前台连续不活跃超过 30 分钟就开新 Session。页面重新加载**不**开新 Session，只在 `$session_start` 的 `navType` 里记录为 `reload`。
- **后台程序**（macOS 菜单栏程序之类）：一次进程运行就是一个 Session。`appStart` 对应 `$session_start`，`navType` 为 `launch`。
- **服务端**：省略。

## 8. 事件目录

`PUT /v1/catalog` 上传一个 JSON 对象，整体替换这个 App 的目录。格式见 [`catalog-v1.json`](../packages/protocol/schema/catalog-v1.json)。

```jsonc
{
  "schemaVersion": 1,
  "events": [
    { "name": "manualSwitch", "description": "用户在自动切换之后又手动改了输入法。",
      "props": { "sinceFocusMs": { "type": "number", "unit": "ms", "description": "从焦点进入到手动切换的间隔。" } } },
    { "name": "key", "description": "一次按键的分类。", "tier": "debug" }
  ],
  "metrics": [
    { "name": "manual_correction_rate", "kind": "ratio",
      "description": "自动切换之后被用户手动纠正的比例。",
      "numerator": { "event": "manualSwitch" },
      "denominator": { "event": "switch", "where": [{ "prop": "ok", "op": "eq", "value": true }] },
      "groupBy": ["app"], "goodDirection": "down" }
  ],
  "funnels": [
    { "name": "record_flow", "by": "session", "windowMs": 1800000,
      "steps": [{ "event": "record.open" }, { "event": "record.input" }, { "event": "record.submit" }] }
  ]
}
```

- **`events`**：事件说明。看板的说明文字、导出和 MCP 返回的数据都带它；目录里没有登记的事件会被标出来。`tier` 为 `debug` 表示这类事件很密，默认只留在客户端本地，不上传。
- **`metrics`**：比率指标，分子事件除以分母事件，可以按 prop 分组。手动纠正率、记账放弃率（`record.abandon ÷ record.open`）都是这一类。
- **`funnels`**：漏斗，2–6 个步骤和一个时间窗口。这些漏斗由应用仓库里的目录文件维护；在看板上临时定义的漏斗另外保存。

这样每个应用自己的分析视角放在自己的仓库里，平台里没有任何某个应用专属的代码。

相对原企划书：目录从「事件数组」改成带 `schemaVersion` 的对象，新增 `metrics`、`funnels` 和 `tier`。

## 9. 两种接入方式

**Relay（有后端的应用）**：浏览器只访问应用自己的同源接口，应用后端用 `@moli-insight/node` 的 `relayHandler` 转发到 `/v1/ingest`。不需要 CORS，key 不会出现在前端，只有登录用户的数据能进来。

**直连（没有后端的应用，例如原生程序）**：客户端带着一个只写的 ingest key 直接调用 `/v1/ingest`。

直连的限制要如实说明：key 放进二进制后**可以被提取**，尤其是公开仓库里的应用。这个 key 只能写入这个 App 的数据，所以泄露的后果是有人能往里写垃圾数据，而不是读出数据。因此直连靠三层兜底：

1. key 不写进源码，由 CI 注入，或由用户在设置里填写；
2. 服务端按设备限流，超过限额返回 429；
3. key 可以随时作废并更换。

如果一个应用以后要分发给不认识的人，这个设计需要重新评估。

## 10. 导入本地日志

已经有本地日志的应用可以把日志补传，保留原来的格式。MoliSwitch 的日志是每天一个 JSONL 文件，每行一个对象：

```json
{"t":"2026-10-02T14:03:21.018+08:00","mono":84224350.1,"e":"manualSwitch","app":"com.tinyspeck.slackmacgap","sinceFocusMs":2410.6}
```

映射规则（实现见 [`import.ts`](../packages/protocol/src/import.ts)）：`t` 变成 `occurredAt`，`mono` 不变，`e` 变成 `name`，其余字段变成 `props`。事件 `id` 由这一行的内容算出（SHA-256 的名字型 UUID），所以同一个文件导入两次，第二次全部被识别为重复。

## 11. 兼容性

同一个 `schemaVersion` 内只做加法：新增可选字段、新增事件、新增 `reason`。破坏性变更要升版本号，服务端同时支持旧版本至少 6 个月。

experimental 包里的标准事件在升入 core 或 web 之前不受此限，这就是把它们单独分出来的原因。

## 12. 与原企划书第 4 节的差异

| 项 | 原企划书 | v1 定稿 | 原因 |
|---|---|---|---|
| `props` 结构 | 一层或两层对象，值只能是原始类型 | 嵌套最多 3 层，4 KB | MoliSwitch 的 `snapshot`、`details`、`field` 本来就是嵌套的 |
| 事件名 | 小写加点 | 允许驼峰 | `appStart`、`manualSwitch` |
| 事件信封 | 无 `mono`、`correlationId` | 新增两个可选字段 | 精确间隔；客户端与服务端事件关联 |
| 事件 `id` | UUIDv7 | 任意 UUID | Swift、Kotlin 没有内置 v7 |
| 时间校正 | 夹到边界 | 先按 `sentAt` 整批平移，再夹边界 | 保持事件间隔和顺序 |
| 超长字符串 | 未明确 | 截断，不拒绝 | 不因为一段文字丢整条事件 |
| 解压后大小 | 未限制 | 512 KB | 防 gzip 炸弹 |
| Session | reload 开新 Session | reload 不开新 Session；后台程序按进程 | 避免 Session 数虚高；适配原生程序 |
| 标准事件 | 一套 | 分 core、web、experimental | 后台程序用不到 `$tap` 之类 |
| 目录 | 事件数组 | 对象，含 `metrics`、`funnels`、`tier` | 应用自己携带分析视图 |
| 直连 | P2 | P0 | 原生程序没有后端可 relay |
| 脱敏 | 靠约定 | 服务端兜底（route、message） | 约定会被忘记 |
| 响应错误 | 401、413、429 | 补充 400 的三种 `error` 码 | 客户端需要区分 |
