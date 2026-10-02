# MoliInsight 企划书

> Moli 系列的自建使用数据平台。目标是用真实的操作数据，找出自家各个应用在布局、流程、体验上的问题，并用数据验证改版有没有效果。
> 第一个接入的是 MoliCashier，第二个是 MoliSwitch。平台本身从第一天起按「多应用、多平台」来设计。

**修订说明（2026-10-02）**：本文以最初的企划书为底，按评审结果修订。主要变化：部署改为 Cloudflare Workers + D1；对照 MoliSwitch 现有的本地使用日志，把原来偏 Cashier 和 Web 的假设改成通用的（直连提到 P0、标准事件分配置包、props 允许嵌套、看板先做通用页面、目录携带比率指标和漏斗）；存储估算和保留期按 D1 的额度重算。线上协议的细节以 [protocol-v1.md](protocol-v1.md) 为准，SDK 签名以 [sdk-api.md](sdk-api.md) 为准，本文不再重复。

---

## 1. 背景与目标

**背景**
- 自家应用的用户只有两个人，两个人对小毛病的耐受度都很高，已经提不出改进意见了。
- 如果每个应用各写一套埋点和看板，就是重复造轮子，而且数据散在各处，没法集中地看和管理。这已经发生了：MoliSwitch 有自己的一套本地使用日志，Cashier 还没有。
- 应用的技术栈各不相同：Next.js（Cashier、Limen）、Swift 原生（MoliSwitch）、Kotlin（CashierHelper）、.NET（Remoter）等。

**目标**
1. **通用采集**：任何应用都能用很少的代码接入。网页应用装上 SDK 后，自动采集访问、页面、点击、快速连点、点了没反应、错误和性能，不用写业务代码。没有 SDK 的平台按 HTTP 协议接入，客户端只需要一百行量级。
2. **通用看板**：不做任何配置，就能看任意一个应用的活跃情况和事件趋势。漏斗和比率可以在页面上临时定义，也可以由应用在自己的仓库里声明。
3. **集中**：所有应用、所有平台的数据在同一个地方查，同一个 MCP 能查。
4. **给 AI 分析用**：数据能完整导出，也能通过 MCP 让 Claude 直接查询。导出时附带事件说明，让 AI 看得懂每个字段的意思。
5. **能比较版本**：每条事件都带版本号，能对比改版前后的变化。

**不做**
- 录屏和会话回放。
- 问卷和主动反馈入口。
- A/B 实验和 feature flag。
- 实时告警。
- 对外开放的多租户服务。

**关于「通用」**：平台里没有任何某个应用专属的代码。应用自己的分析视角（指标、漏斗）放在应用自己仓库的事件目录里，上传给平台。验证方式是 M2：Cashier（Web，有后端）和 MoliSwitch（原生，没有后端）在不改平台代码的前提下接入。

## 2. 核心概念

| 概念 | 说明 |
|---|---|
| App | 一个被接入的应用，例如 `cashier`、`switch`。有自己的 ingest key、保留期和事件目录。 |
| Platform | 事件来自哪个平台：`web`、`ios`、`android`、`windows`、`macos` 或 `server`。 |
| Release | 应用的版本标识。网页应用一般用部署时的 git SHA，原生程序用版本号。 |
| Device | 一个匿名安装实例，用 `deviceId` 标识，客户端第一次运行时生成并长期保存。 |
| Person | 可选。在看板里把多个 Device 归到同一个人名下（例如「我」「她」），可以跨应用使用。 |
| Session | 一次连续使用。网页：前台连续不活跃超过 30 分钟算新 Session，**页面重新加载不算**。后台程序：一次进程运行。 |
| Event | 一条事件，包含名称、时间、属性和所属 Session。 |

## 3. 整体架构

```
Web（有后端）
  浏览器 ──(SDK)──► 应用自己的后端 /api/telemetry（同源，检查登录态）
                          │  Node SDK 的 relay helper
                          ▼
原生程序（无后端）          │
  客户端 ──(HTTP)─────────►│
                          ▼
              MoliInsight  POST /v1/ingest（Bearer app key）
              Cloudflare Workers ── D1
                          │
         ┌────────────────┼──────────────────┐
      看板 (SPA)       导出 (ndjson)      MCP（给 Claude 用）
```

- **Relay 模式**（有后端的应用）：浏览器只访问自己应用的同源接口。这样做有几个好处：
  - 不需要处理 CORS 和 CSP，也不容易被广告拦截器挡掉。
  - app key 不会出现在前端代码里。
  - 只有登录用户的数据能进来。
- **直连模式（P0）**：给没有后端的应用用，例如 MoliSwitch。客户端带一个只写的 ingest key 直接调用 `/v1/ingest`。key 放进二进制后可以被提取，所以靠按设备限流和可随时作废来兜底，不写进源码。详见 [protocol-v1.md](protocol-v1.md) 第 9 节。
- **服务端事件**：应用后端也可以直接上报事件，`platform` 填 `server`，例如 AI 处理完成。用 `correlationId` 把它和客户端事件串起来。

## 4. 接收协议 v1（这是平台的核心契约，务必稳定）

完整定义见 [protocol-v1.md](protocol-v1.md)，机器可读的 JSON Schema 和 TS 类型在 `packages/protocol`，由 Zod 定义生成。这里只列要点和相对最初企划书的变化。

- **接口**：`POST /v1/ingest`（上报）、`PUT /v1/catalog`（上传事件目录）、`GET /v1/export`、`/mcp`。key 以 `mi_` 开头（只写），admin token 以 `mia_` 开头（可读）。服务端只保存 HMAC。
- **请求**：支持 `Content-Encoding: gzip`。压缩后最大 64KB，解压后最大 512KB，每批最多 100 条事件。`context` 整批共享，`events` 每条带 `id`（任意 UUID，去重用）、`name`、`occurredAt`，可选 `mono`、`sessionId`、`correlationId`、`route`、`props`。
- **事件名**：`^\$?[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$`，最长 64。允许驼峰，因为现有的原生程序已经在用。`$` 开头留给 SDK 的标准事件。
- **props**：JSON 对象，允许嵌套，最多 3 层，序列化后不超过 4KB。字符串超过 200 字时截断，不拒绝；数组最多 20 项。
- **时间**：服务端用 `接收时间 − sentAt` 作为这一批的时钟误差，整批平移，再夹到「不晚于接收时间 5 分钟、不早于接收时间 7 天」的窗口。
- **去重**：同一个 App 下 `id` 唯一，重复的事件静默忽略，所以重发是安全的。
- **响应**：`200 { accepted, duplicates, rejected: [{ index, reason }] }`。部分不合法时整批不会失败。`400` 请求体或 envelope 有问题；`401` key 无效；`413` 太大；`429` 超过限额，带 `Retry-After`。
- **脱敏兜底**：服务端去掉 `route` 里 query 的值，把 `message` 和 `error` 里连续 4 位及以上的数字替换成 `#`。这只是兜底，客户端仍要遵守第 8 节的隐私原则。
- **兼容性**：同一个 `schemaVersion` 内只做加法。破坏性变更要升一个版本号，并且服务端同时支持旧版本至少 6 个月。

### 标准事件（以 `$` 开头，由 SDK 产生，看板原生理解）

按**配置包**分组，平台只需要实现自己的那个包：

| 包 | 事件 | 说明 |
|---|---|---|
| core（所有平台，首个版本发布后冻结） | `$session_start`、`$error` | 活跃情况、入口、错误 |
| web（Web SDK 自动采集） | `$visibility`、`$screen`、`$tap`、`$rage_tap`、`$dead_tap`、`$vital` | 使用时长、页面与导航、功能使用度、「用户在着急」、「以为能点」、性能 |
| experimental | `$op`、`$dialog`、`$toast` | 有耗时的操作、浮层、用户看到的提示。只在一个应用里验证过，第二个应用验证后再升级，期间 props 仍可调整 |

`$op`、`$dialog`、`$toast` 要靠应用在自己的公共组件里调用 SDK 来上报。后台程序用不到 `$tap` 之类的 web 事件，这是预期：标准事件是通用的下限，不是上限。

**应用自定义事件**：
- 格式为 `领域.动作`（`record.submit`、`detail.edit`），驼峰也可以（`manualSwitch`）。
- 属于哪个应用由 key 决定，不需要在事件名里加前缀。

### 事件目录（P1）：`PUT /v1/catalog`
- 应用在 CI 中，或者手动上传一份 JSON：`{ schemaVersion, events, metrics?, funnels? }`。
- 用途：
  - 看板上的说明文字。
  - 导出时附带说明。
  - MCP 返回的数据里附带说明，让 Claude 能看懂。
  - 发现「目录里没有登记的事件」并给出提示。
  - **`metrics`**：比率指标（分子事件 ÷ 分母事件，按 prop 分组）。MoliSwitch 的手动纠正率是 `manualSwitch ÷ switch`，Cashier 的放弃率是 `record.abandon ÷ record.open`。
  - **`funnels`**：应用自己的漏斗，随目录一起维护。
  - **`tier`**：标注 `debug` 的事件很密，默认只留在客户端本地，不上传。
- 推荐每个应用在仓库里保留一份 `telemetry-catalog.json`，作为事件目录的唯一来源。

## 5. SDK

详细的 API 见 [sdk-api.md](sdk-api.md)，签名在 M0 定稿，实现在 M2。

### 5.1 Web SDK（P0）
- **技术要求**：零依赖，ESM，自带 TS 类型。在服务端渲染（SSR）环境中调用是安全的，会自动变成什么都不做。**gzip 后目标不超过 4KB**，各项自动采集可以单独摇树掉，以免挤占应用的 bundle 预算。
- **API**：`init`、`track`、`trackScreen`、`reportVital`、`startOp`、`trackDialog`、`flush`、`setEnabled`、`getDeviceId`。
- **队列**：
  - 事件先进内存队列，只在页面隐藏、定时或攒满时写入**这个标签页自己的** localStorage 键（`moli_insight_q_<tabId>`），上限 500 条，超出时丢掉最旧的。这样两个标签页不会互相覆盖。
  - 每 15 秒或攒满 50 条发送一次。页面隐藏或关闭时用 `sendBeacon` 发送。
  - 服务端返回 401 时保留队列，等用户登录后再发；返回 429 或 5xx 时指数退避重试。
- **身份**：
  - `deviceId` 存在固定的键 `moli_insight_device_id` 下，所有键都以 `moli_insight_` 开头，应用在「退出登录时清理本地数据」时要避开它们。
  - iOS Safari 对非 PWA 站点的脚本存储 7 天不用会清理，PWA 与 Safari 的存储也互相独立，同一台手机可能出现多个 `deviceId`，用「设备归属到人」归并。
  - `sessionId` 按第 2 节「核心概念」中 Session 的规则生成。
- **点了没反应（`$dead_tap`）的判定**：点在**看起来可点**的元素上（`cursor: pointer`、可交互的 `role`、`data-track`、自带点击处理），并且 1 秒内没有 DOM 变化（用 MutationObserver 判断）、没有 URL 变化、也没有焦点变化。点在文字和空白处不算，否则误报太多。
- **快速连点（`$rage_tap`）的判定**：800ms 内在 30px 范围里点击 3 次以上。
- **元素标记约定**：给控件加上 `data-track="区域.控件"`，例如 `topbar.period_next`。没有标记时，依次退回到 `aria-label`、元素角色、最近一个带 `data-track` 的祖先。
- **隐私**：永远不读取输入框的值和元素里的文字。错误堆栈只保留第一帧的文件名和行号。

### 5.2 Node SDK（P0，体积很小）
```ts
const insight = createInsight({ url: process.env.INSIGHT_URL, key: process.env.INSIGHT_KEY })
// 一行代码完成 Relay，给 Next 的 route handler 用：
export const POST = insight.relayHandler({ authorize: async (req) => Boolean(await getSession()) })
// 服务端事件：
await insight.send([{ name: "processing.finished", props: { ms, ok }, correlationId }])
```
- 没有配置 `url` 或 `key` 时自动关闭：relay 直接返回 204，`send` 什么也不做。这样本地开发和测试零影响。
- relay 只做三件事：检查请求体大小、调用 `authorize`、透传数据。转发失败时只记录状态码，不记录请求内容。

### 5.3 其他平台
- **Swift（MoliSwitch）在 M2 做**，因为它是第二个参考应用。做法是在它现有的 `UsageLogging` 协议上加一个 HTTP sink，与本地 JSONL 日志并联；本地日志继续充当离线队列和完整的调试记录。放在 `clients/swift/`，不单独发包。
- Kotlin（CashierHelper）、.NET（Remoter）等以后再做。在那之前，直接按第 4 节的协议调用 HTTP 接口即可。

## 6. 看板（Web，只给自己人用）

看板是一个静态单页应用，由 Worker 提供。**先做对所有平台通用的页面**；摩擦点和性能只对 Web 有意义，排在后面。

**通用控件**：应用、平台、时间范围（7 / 30 / 90 / 180 天 / 自定义）、人或设备、版本。

| 页面 | 内容 | 优先级 |
|---|---|---|
| 概览 | 活跃天数、Session 数、使用时长分布、设备和平台占比、按人拆分 | P0 |
| 事件浏览器 | 按事件名看趋势，可以按某个 prop 分组或筛选，可以查看原始事件 | P0 |
| 管理 | App 的增删改；key 的生成、轮换、作废（只显示一次）；设备归属到人；每个 App 的保留期；按设备删除数据 | P0 |
| Session 时间线 | 某一个 Session 的事件按时间排列，像看「操作回放」的文字版 | P1 |
| 漏斗与比率 | 在页面上选 2–6 个事件作为步骤，可以加属性条件，可以设置时间窗口。显示转化率、各步耗时中位数和流失点，可以保存；同时展示目录里声明的比率指标和漏斗 | P1 |
| 版本对比 | 选两个版本，对比关键指标 | P1 |
| 摩擦点（Web 包） | 快速连点和点了没反应最多的控件、开了又取消的对话框、`$error` 和 `$toast`（错误级别）排行 | P1 |
| 性能（Web 包） | `$vital` 按页面的 p75，`$op` 按操作的 p50/p95 和失败率 | P1 |
| 导航（Web 包） | 页面之间的跳转关系，以及每个页面最常见的下一步 | P2 |
| 功能使用度 | 看过的页面、点过的控件。对照事件目录，列出「从没用过」的功能 | P2 |

读取走每日汇总表和索引，不直接扫原始事件（见第 9 节的 D1 约束）。性能、漏斗等在看板出来之前，可以先通过导出和 MCP 查询。

## 7. 给 AI 用的出口

### 7.1 导出（P0）`GET /v1/export?app=&from=&to=`（需要看板登录，或者 admin token）
- **默认 `ndjson` 流式输出**，按天分页：第一行是头部（格式、版本、App、时间范围、事件目录、人、设备、版本列表、汇总），之后每行一条原始事件，按时间排序。不一次性返回完整 JSON，因为单个响应有大小限制，也撑不住几十万行。
- 需要整份 JSON 的场景，用 `format=json` 并限制在一天或一个较小的范围内。
- 头部里的汇总和看板概览、事件浏览器使用相同的口径。
- 精确的行格式在 M3 定稿。

### 7.2 MCP 接口（P1）`/mcp`（Streamable HTTP，Bearer admin token）
- **工具**：
  - `list_apps`
  - `get_catalog(app)`
  - `summary(app, range, groupBy?)`
  - `query_events(app, filter, limit)`
  - `metric(app, name, range, groupBy?)`（目录里声明的比率指标）
  - `funnel(app, steps, window)`
  - `compare_releases(app, a, b)`
  - `session_timeline(sessionId)`
- 所有工具强制 `limit` 并裁剪字段，避免一次返回太多。
- **目的**：在任意一个应用的仓库里，Claude Code 都能直接查这个应用的数据，也能跨应用查，再结合代码给出改进方案。

## 8. 安全、隐私与保留期
- **隐私原则**（写在平台的 README 里，所有接入方都要遵守）：
  - 不采集：自由文本（备注、搜索词、输入内容）、金额等业务数值、图片、邮箱、token、IP。
  - 只采集：长度、数量、字段名、控件标识、错误类型。
  - 错误信息里的错误码放进单独的属性，不要拼进 `message`：服务端会掩掉 `message` 里 4 位及以上的数字。
  - 服务端不保存 IP。User-Agent 只解析成粗粒度的 `os` 和 `client` 后保存。
- **看板登录**：使用口令登录。环境变量里存口令的哈希，登录后发签名 cookie，失败时限流。这个设计只够两个人用，不需要账号体系。
- **key 的管理**：
  - ingest key 只能写入。admin token 可以读取，用于导出和 MCP。
  - 两种 key 都可以随时作废，服务端都只保存 HMAC。
  - 直连的 key 会被放进客户端，可能被提取，所以按设备限流，并且能随时作废（见第 3 节）。
- **保留期**：
  - 每个 App 单独配置，**默认 90 天**，最长可配 3650 天。
  - 高频事件（`$tap`、`$visibility`）只保留 30 天，到期前按天汇总进日表（M3）。
  - 每天由一个 Cron Trigger 分批删除过期行。
  - 支持按设备一键删除数据（外键级联）。

## 9. 技术方案与部署

整个平台跑在 Cloudflare 上。**不再用 Vercel + Postgres**：Vercel 到 D1 只能走 REST，延迟和限速会抵消 D1 的优点；而 Workers 加 D1 没有冷启动、免费版就带 7 天的 Time Travel 恢复、Cron Trigger 更灵活、响应可以流式输出。

- **技术栈**：Hono（Workers）+ Drizzle（D1）+ Zod + Vitest（集成测试用 `@cloudflare/vitest-pool-workers`，即 Miniflare）。工程规范沿用 MoliCashier，包括 `npm run check` 门禁、手写迁移 SQL（走 `wrangler d1 migrations`）和约束命名约定。看板是静态 SPA（Workers Assets），不做服务端渲染。
- **仓库结构**：npm workspaces。
  - `packages/protocol`：Zod 定义、JSON Schema、规范化规则。协议的唯一来源。
  - `packages/insight-web`、`packages/insight-node`：SDK，以公开的 scoped npm 包发布。
  - `apps/worker`：Hono 服务（ingest、导出、MCP、cron）。
  - `apps/dashboard`：看板 SPA。
  - `clients/`：没有 SDK 包的平台的客户端，先放 Swift。
- **部署**：Cloudflare Workers + D1。免费版的 Worker 每次调用只有 10ms CPU，解压、校验 100 条事件再写入可能紧张，实测不够时升级 Paid（$5/月，CPU 30 秒）；看板不做 SSR，所以不受影响。
- **数据量估算**：
  - 两个人加上 MoliSwitch，产品事件每天大约 2–5k 条，保留 90 天大约 20–45 万行。
  - D1 里一行事件（含 JSON props 和 3 个索引）大约 500–800 字节，总量约 100–350MB。D1 免费版**单库 500MB**，仍然在边缘，要关注实际用量。
  - 余量不够时依次：缩短高频事件的保留期、加日汇总、一个应用一个库（免费版允许 10 个）、升级 Paid（单库 10GB）。
- **数据表**：
  - `apps`、`app_keys`、`admin_tokens`、`people`、`devices`、`sessions`、`events`、`catalog_entries`（事件、指标、漏斗三种条目，用 `kind` 区分）、`saved_funnels`。
  - `events` 表上的唯一约束：`uq_events_app_event_id`。
  - `events` 表上的索引：`idx_events_app_occurred_at`、`idx_events_app_name_occurred_at`。
  - 迁移见 `apps/worker/migrations/0001_init.sql`。
- **D1 使用约束**：
  - 每条语句最多 100 个绑定参数，所以批量写入用 `db.batch()`，每条事件一条语句，用每条语句的 `meta.changes` 统计 `duplicates`。
  - 每个索引在写入时也算一次「写入行」，免费版每天 10 万行。每条事件大约 4–5 次，所以索引只加查询确实需要的。
  - 免费版每天只能读 500 万行。扫描一个 90 万行的表一次就是 90 万，所以看板读日汇总表，查询必须走索引，MCP 的工具必须带范围和 `limit`。
  - 没有 `percentile_cont`。p50/p75/p95 用 `NTILE` 窗口函数，或者取出数值在代码里算。
  - 没有 `jsonb` 和 GIN 索引。按 prop 分组用 `json_extract`，特别常用的 prop 可以建生成列再加索引。
- **非功能要求**：
  - ingest 在平台内部的处理 p95 小于 300ms（不含网络）。
  - 平台挂掉时不能影响被接入的应用：SDK 和 relay 全部 fire-and-forget，失败时静默。
  - 限流用 Workers 的 Rate Limiting binding，不用内存计数。

## 10. 里程碑与验收

先收数据，再做看板：数据要攒几周才有分析价值，而原始数据一旦收进来，看板可以晚一点做。

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| M0 契约 | 定稿接收协议 v1、标准事件、SDK API、目录格式；仓库骨架和第一个迁移 | 第 4–5 节的文档定稿，有 JSON Schema 和 TS 类型；MoliSwitch 的真实事件样例能通过校验；迁移在本地 D1 上应用成功 |
| M1 能收 | ingest（relay 和直连两种）、去重、限额、数据表、口令登录、管理页（App 和 key）、保留期 cron、`moli-insight import` 命令 | 用 curl 发送正常批次、非法批次、重复批次，结果都符合预期；Miniflare 集成测试通过；MoliSwitch 的样例日志能导入，重复导入不新增 |
| M2 SDK 与接入 | 发布 insight-web 和 insight-node 0.1.0，做 Swift 客户端；接入 Cashier 和 MoliSwitch | 两个应用都**不改平台代码**就接入；demo 页面验证自动采集到的全部 web 包标准事件；bundle 体积不超过 4KB gz；单元测试覆盖队列、beacon、401 时保留、多标签页、快速连点和点了没反应的检测；两个应用的数据都能通过导出读到 |
| M3 能看 | P0 看板页面（概览、事件浏览器、管理）和导出；日汇总表 | 两个应用都在同一个看板里有数据；导出符合第 7.1 节的格式 |
| M4 能问 | 漏斗与比率、Session 时间线、版本对比、摩擦点、性能、事件目录、MCP | 在 Claude Code 里通过 MCP 同时拿到 Cashier 的漏斗数据和 MoliSwitch 的手动纠正率 |

## 11. 做完后交回来的东西（用于接入 Cashier 和 MoliSwitch）
1. ingest URL，以及最终版的接收协议 v1 文档。如果和本企划书有出入，请标出差异（已列在 protocol-v1.md 第 12 节）。
2. 两个 npm 包的名字和版本，以及 `init`、`relayHandler` 的最终签名。
3. 应用需要设置的环境变量名，例如 `INSIGHT_URL` 和 `INSIGHT_KEY`。**key 本身直接填进部署平台，不要发给我。**
4. SDK 在 localStorage 中使用的键名前缀 `moli_insight_`，Cashier 退出登录时需要避开它。
5. 事件目录的上传方式：通过 CLI，还是调用 API。
6. 如果做好了 MCP：它的地址，以及 token 的配置方式。
7. 直连的接入说明：ingest key 怎么注入 MoliSwitch 的构建，以及按设备限流的数值。

## 附：Cashier 接入预告（等你交回接口后由我来做）
- 新建 `src/app/api/telemetry/route.ts`，用 `relayHandler` 加上 `requireAuth` 完成转发。
- 新建 `src/instrumentation-client.ts`，调用 `init` 并上报路由变化。在 Providers 里把 `useReportWebVitals` 的数据交给 SDK。
- 公共入口：
  - `useLedgerMutation` 改为上报 `$op`，并新增必填的 `name`。
  - `postLedgerQuery` 上报 `$op`。
  - Dialog 和 overlay-history 上报 `$dialog`。
  - toast 包装器上报 `$toast`。
  - `error.tsx` 上报 `$error`。
- 业务事件：
  - 记账漏斗：`record.open`、`record.input`、`record.submit`、`record.result`、`record.abandon`、`record.draft`。
  - AI 纠错：`detail.edit`。
  - 其他操作：筛选、切换期间、统计、批量操作、设置、登录。
  - 服务端：`processing.finished`，带 `correlationId`。
- 在 Cashier 仓库里维护 `telemetry-catalog.json`（含 `metrics` 和 `funnels`），并更新 `docs/architecture.md`。

## 附：MoliSwitch 接入预告
- 在 `UsageLogging` 协议上新增 HTTP sink，与 `JSONLUsageLogger` 并联；不改日志格式。
- 只上传产品事件：`appStart`、`setting`、`ruleEdit`、`switch`、`switchSkipped`、`manualSwitch`、`fieldFocus`、`slashEnd`、`error`。`key`、`diag`、`snapshot`、`systemInputSourceChanged` 只留本地，需要时用 `moli-insight import` 补传。
- 设置里的「使用日志」开关同时控制两者。
- 在仓库里维护 `telemetry-catalog.json`，把 `key`、`diag`、`snapshot` 标成 `tier: debug`，并声明 `manual_correction_rate = manualSwitch ÷ switch`（按 `app` 分组，越低越好）。
- 错误信息里的错误码放进单独的 `code` 属性。
