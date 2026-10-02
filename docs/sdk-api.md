# SDK API

两个 SDK 的签名在 M0 定稿，类型在 [`packages/insight-web/src/types.ts`](../packages/insight-web/src/types.ts) 和 [`packages/insight-node/src/types.ts`](../packages/insight-node/src/types.ts)，M2 已实现。线上格式见 [protocol-v1.md](protocol-v1.md)。

两个 SDK 都遵守同一条原则：**平台出问题时不能影响应用。** 所有调用都不抛异常，失败时静默；服务端渲染环境里全部变成什么都不做。

包名暂用 `@moli-insight/web` 和 `@moli-insight/node`，版本 0.1.0。两个包目前是 `private`，**还没有发布到 npm**：npm scope 和账号未定，定下后去掉 `private` 即可（构建脚本、`exports` 和 `files` 已经就绪：`npm run build -w @moli-insight/web`）。在此之前，应用可以用 `npm pack` 出来的 tarball，或 git 依赖。

## 环境变量

| 名称 | 谁用 | 说明 |
|---|---|---|
| `INSIGHT_URL` | 应用后端 | MoliInsight 的地址，例如 `https://insight.example.workers.dev` |
| `INSIGHT_KEY` | 应用后端 | ingest key（`mi_…`）。**直接填进部署平台，不要经过聊天或仓库** |

任何一个没配置，Node SDK 就自动关闭：`relayHandler` 直接返回 204，`send` 什么也不做。本地开发和测试因此零影响。

## localStorage 的键

应用在**退出登录时清理本地数据**，要避开所有以 `moli_insight_` 开头的键。

| 键 | 内容 |
|---|---|
| `moli_insight_device_id` | 设备 ID。清掉它，这个浏览器会被当成一台新设备 |
| `moli_insight_q_<tabId>` | 这个标签页还没发出去的事件队列 |
| `moli_insight_session` | 当前 Session，格式 `<id>.<最后活动毫秒>`，各标签页共用 |

`sessionStorage` 里还有一个 `moli_insight_tab`（标签页自己的 ID）。

每个标签页一个队列键，是为了避免两个标签页同时读改写同一个键而互相覆盖。标签页关闭后遗留的队列由下一个标签页接手发送。

## Web SDK：`@moli-insight/web`

零依赖，ESM，自带 TS 类型。gzip 后目标不超过 4 KB，各项自动采集都可以单独摇树掉。

```ts
init({
  endpoint: "/api/telemetry",
  release: process.env.NEXT_PUBLIC_GIT_SHA,
  autoCapture: { taps: true, rage: true, dead: true, errors: true, screens: true, visibility: true },
  enabled: true,
})

track(name, props?)
trackScreen(screen, via?)           // 给框架路由钩子用，例如 Next 的 onRouterTransitionStart
reportVital(metric)                 // 直接接收 useReportWebVitals 回调里的对象
startOp(op) → { end({ ok, errorKind?, props? }) }     // 产生 $op，ms 自动填
trackDialog(name, "open" | "close", { closeBy? })
flush(): Promise<void>
setEnabled(enabled)
getDeviceId(): string | undefined
```

`autoCapture` 各项默认都开；传 `false` 表示全部关闭。

### 队列与发送

- 事件先进内存队列，只在页面隐藏、每 15 秒或攒满 50 条时才写入这个标签页自己的 localStorage 键。上限 500 条，超出时丢掉最旧的。
- 每 15 秒或攒满 50 条发送一次，每批最多 100 条、约 60 KB。页面隐藏或关闭时先落盘，再用 `sendBeacon`（不压缩）；上一次是 401 或 429 时不发 beacon，留在队列里。
- `flush()` 返回正在进行的那次发送，所以 `await flush()` 一定等到结果。
- 每次发送都重新取 `sentAt`，不是事件入队的时间。
- 401：保留队列，等 60 秒再试（用户登录后即可发出）。429：按 `Retry-After` 等待。5xx 和网络错误：从 15 秒起指数退避，上限 10 分钟。其他 4xx：丢弃这一批。
- 标签页关闭后留下的队列，超过 120 秒没有更新就由下一个标签页接手。

### 身份

- `deviceId` 第一次运行时生成，存在固定的键下。iOS Safari 对非 PWA 站点的脚本存储 7 天不用会清理，PWA 与 Safari 的存储也互相独立，所以同一台手机可能出现多个 `deviceId`；用看板里的「设备归属到人」把它们归并。
- `sessionId` 按协议第 7 节：前台连续不活跃超过 30 分钟开新 Session，页面重新加载不开新 Session；多个标签页共用同一个 Session。只有真正新开的 Session 才发 `$session_start`（带 `entry` 和 `navType`）。
- 存储不可用（隐私模式、被禁用）时 `getDeviceId()` 返回 `undefined`，事件不带 `deviceId`，不会每次生成一个新的。

### 自动采集的判定规则

- **`$rage_tap`**：800 ms 内在 30 px 范围里点击 3 次以上。
- **`$dead_tap`**：点在**看起来可点**的元素上（计算样式 `cursor: pointer`、有可交互的 `role`、带 `data-track`，或自身带点击处理），并且 1 秒内没有 DOM 变化（MutationObserver）、没有 URL 变化、也没有焦点变化。点在文字、空白和只读区域不算，否则误报会淹没真正的信号。
- **元素标记**：给控件加上 `data-track="区域.控件"`，例如 `topbar.period_next`。没有标记时，依次退回到 `aria-label`、元素角色、最近一个带 `data-track` 的祖先。
- **隐私**：永远不读取输入框的值和元素里的文字。错误堆栈只保留第一帧的文件名和行号。
- **错误**：每个页面最多上报 10 个，重复的只报一次。
- **体积取舍**：为了守住 4 KB，Web SDK 的事件不带 `mono`，`context` 不带 `locale`；时间差用 `occurredAt` 就够了，语言需要时用 `$session_start` 的自定义属性。

## Node SDK：`@moli-insight/node`

```ts
const insight = createInsight({
  url: process.env.INSIGHT_URL,
  key: process.env.INSIGHT_KEY,
  release: process.env.VERCEL_GIT_COMMIT_SHA,   // 可省略，默认就是它
  timeoutMs: 3000,
  onError: ({ status }) => {},                  // 只收到状态码，不含请求内容
})

// 一行代码完成 Relay，给 Next 的 route handler 用：
export const POST = insight.relayHandler({
  authorize: async (req) => Boolean(await getSession()),
})

// 服务端事件，platform 填 "server"：
await insight.send([
  { name: "processing.finished", props: { ms, ok }, correlationId: recordId },
])
```

`relayHandler` 只做三件事：检查请求体大小、调用 `authorize`、透传。转发失败时只记录状态码，不记录请求内容。

| 情况 | 响应 |
|---|---|
| 转发成功，或 SDK 未配置 | 204 |
| `authorize` 返回 false | 401（浏览器保留队列） |
| 请求体超过 `maxBodyBytes`（默认 65536） | 413 |
| MoliInsight 返回 429 | 429，带上它的 `Retry-After` |
| MoliInsight 返回 401 或 5xx，或不可达、超时 | 503（浏览器退避；401 说明服务端的 key 配错了，浏览器无能为力） |
| MoliInsight 对这一批返回其他 4xx（400、413 …） | 400（413 原样），让浏览器丢掉这一批，不要无限重试 |
| `authorize` 自己抛异常 | 503 |
| 不是 POST | 405 |

`send()` 是尽力而为：每 100 条一批，**不重试**，永不抛异常，失败只通知 `onError`。需要可靠送达的事件应该先落在应用自己的库里。

`correlationId` 把服务端事件和客户端事件串起来：客户端在 `record.submit` 里带上同一个值，看板就能把「提交」和「处理完成」连成一次记账。

## 其他平台

没有 SDK 包。按 [protocol-v1.md](protocol-v1.md) 直接调用 HTTP 接口，客户端要做的事很少：

1. 生成并保存 `deviceId`，按平台规则生成 `sessionId`；
2. 把事件攒成批，每批最多 100 条，用 `/v1/ingest` 发送；
3. 失败时按协议第 5 节的规则重试，并保留没发出去的事件。

### MoliSwitch（Swift）

不改它现有的日志格式。`UsageLogging` 本来就是一个协议，所以新增一个 HTTP sink，与 `JSONLUsageLogger` 并联：

- 本地的 JSONL 文件继续写，同时充当离线队列和完整的调试记录；
- HTTP sink 只上传**产品事件**（目录里 `tier` 不是 `debug` 的），`key`、`diag`、`snapshot`、`systemInputSourceChanged` 这类很密的调试事件只留本地；
- 需要深入排查时，用 `moli-insight import --app switch usage-YYYY-MM-DD.jsonl` 把整天的日志补传；
- 用户在 MoliSwitch 里关掉使用日志，HTTP sink 也一起关；
- ingest key 不进源码，由 CI 注入或在设置里填（见协议第 9 节）。

事件的 `context`：`platform: "macos"`、`deviceClass: "desktop"`、`release` 为应用版本号，Session 为一次进程运行。
