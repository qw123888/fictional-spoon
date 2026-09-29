# 电话通知站（Phone Notify）

给监听器加的一层「**电脑发信号 → 网站接收 → 处理模块 → 拨打电话**」闭环。
网站跑在 Cloudflare（Workers + 静态资源），电脑端只保留一个可被任意模块调用的**桥接接口**。

界面配色和字体沿用原监听器（深色 `#1e1e1e` 底、`#d4d4d4` 正文、Consolas 等宽、Microsoft YaHei），
打开控制台就像在看监听器的日志面板。

---

## 1. 闭环长什么样

```
┌──────────────────────────┐        POST /api/signal         ┌───────────────────────────────┐
│  监听器（电脑 / Python） │ ──────────────────────────────▶ │  Cloudflare Worker（本站）    │
│  discord_monitor.py      │   {kind,title,content,source}   │  ① 访问令牌校验               │
│        │                 │                                 │  ② 总开关 / 时间段判定        │
│        ▼                 │                                 │  ③ 防轰炸（去重·间隔·时/日配额）│
│  notify_bridge.NotifyBridge ── 可选：独立 CLI / 其它程序 ──▶ │  ④ 重试 → 调通道适配器        │
└──────────────────────────┘                                 │  ⑤ 写日志 / 健康快照 / 兜底   │
                                                             └───────────────┬───────────────┘
                                                                             │ POST /xsend/<AppKey>
                                                                             ▼
                                                              Spug 推送助手（voice 语音电话）
```

关键点：监听器**不直接**碰电话接口，永远只往 `NotifyBridge` 丢事件；
通道实现（Spug 语音 / Webhook / 以后新增的短信、飞书、钉钉…）全部以**适配器**形式注册进 `CommModule`。

---

## 2. 目录结构

```
fictional-spoon/
├─ src/
│  ├─ index.js                 # Worker 入口 + 全部 HTTP 路由（/api/*）
│  ├─ signal.js                # 信号接收接口：字段归一化 + 校验
│  ├─ comm/
│  │  ├─ index.js              # ★ CommModule：主通信接口（所有通知的唯一出口）
│  │  ├─ dialer.js             # 电脑端拨号：把"最后一通拨号请求"丢进队列交给电脑发
│  │  ├─ channel.js            # ChannelAdapter 基类 + ChannelRegistry
│  │  └─ channels/
│  │     ├─ spug_voice.js      # 电话通道（Spug 语音）
│  │     └─ webhook.js         # 备用通道
│  └─ core/
│     ├─ config.js             # 配置读写 + 默认值 + 客户端补丁合并
│     ├─ window.js             # 通知时间段（时区 / 星期 / 多区间 / 跨天）
│     ├─ guard.js              # 防轰炸：去重、最小间隔、每小时/每天上限（默认对齐 Spug 流控）
│     ├─ outbox.js             # 拨号任务队列（KV：outbox:v1 / executor:v1，租约 90s）
│     ├─ store.js              # 三级存储：KV → 边缘缓存(Cache API) → 内存
│     ├─ logger.js             # 通知日志 + 计数
│     └─ auth.js               # 访问令牌
├─ public/                     # 控制台界面（index.html 分页面板 / style.css / app.js）
├─ functions/api/[[route]].js  # 若改用 Cloudflare Pages，走这个适配入口
├─ pc/notify_bridge.py         # 电脑端桥接模块（同步副本，源头在监听器目录）
├─ pc/dial_executor.py         # 电脑端拨号执行器（同源副本；监听器启动时自动拉起）
├─ local/server.mjs            # 本地开发服务器（Node，无需 wrangler）
├─ test/run.mjs                # 后端自动化测试（mock 掉电话接口，不拨号）
├─ test/dom-smoke.mjs          # 前端烟雾测试：真的跑 app.js 验面板切换与保存反馈
├─ test/check-dom.mjs          # 接线自检：JS 引用的 id 在 HTML 里都存在
├─ wrangler.toml
└─ package.json
```

---

## 3. 本地跑起来

```bash
npm install
npm run dev          # → http://127.0.0.1:8787
npm test             # 后端测试（不需要网络、不会拨号）
npm run test:dom     # 前端烟雾测试（需先 npm i -D linkedom，可选）
```

`local/server.mjs` 会把请求喂给同一份 Worker 代码，并把 KV 落盘到 `local/data/kv.json`，
所以本地能完整验证时间段、去重、日志、令牌这些逻辑。令牌等敏感值放在 `.dev.vars`（已被 gitignore）：

```ini
SPUG_BASE_URL=https://push.spug.cc
SPUG_CHANNEL=voice
SPUG_APP_KEY=ak_你的AppKey
SIGNAL_TOKEN=你自定义的一串令牌          # 电脑端发信号要用同一个
```

浏览器打开 `http://127.0.0.1:8787` → 右上「访问令牌」填同一个令牌 → 保存。

跑测试：

```bash
npm test             # 通过 71，失败 0；全程 mock，不联网、不拨号
```

---

## 4. 电脑端接入（监听器）

### 4.1 配置

`config.json` 增加 `notify` 段（`config.example.json` 里有完整模板）：

```json
"notify": {
  "enabled": true,
  "site_url": "http://127.0.0.1:8787",
  "token": "与站点一致的那串令牌",
  "timeout": 8,
  "retry": 1,
  "content_limit": 120,
  "title_template": "{source_label}新消息",
  "content_template": "#{channel} {author}: {content}",
  "sources": ["discord"]
}
```

`enabled=false` 时整个模块静默——监听器行为与加功能之前完全一致。

### 4.2 监听器里已接好的挂钩

- `discord_monitor.py`：`ChannelMonitor(config, log_callback=…, notify_callback=…)`
  新增第三个可选参数。消息**通过过滤并转发飞书后**，会调一次
  `notify_callback({source,id,channel,author,content,images,ts})`；挂钩抛异常只会记一条 warn，不影响转发。
- `app.py`：启动监控时自动用当前 `config.json` 构造 `NotifyBridge`，把 `bridge.on_message` 作为挂钩传入；
  工具栏多了「📞 测试电话」按钮，走网站 `/api/test-call`（强制拨号，绕过时间段与去重）。

### 4.3 任何程序都能用的桥接接口

```python
from notify_bridge import NotifyBridge

bridge = NotifyBridge.from_config(config)      # 读 config.json 的 notify 段
bridge.on_message({"source": "discord", "channel": "频道名", "author": "某人",
                   "content": "消息正文", "id": "123"})   # 异步入队，立刻返回
bridge.notify("自定义标题", "自定义内容", source="manual")  # 直接指定内容
bridge.test()                                              # 同步测试电话
bridge.status()                                            # 网站健康快照
```

特性：后台线程发送、队列满丢弃不阻塞、任何网络异常都不上抛（打电话失败绝不能拖垮监控）。

命令行自测：

```bash
py -3 notify_bridge.py --status                     # 看网站状态
py -3 notify_bridge.py --test                       # 打一通测试电话
py -3 notify_bridge.py --signal "标题" "内容"        # 发一条普通信号
```

### 4.4 电脑端拨号（Spug 的 App Key 绑了 IP 白名单时必须用这个）

**问题**：Spug 的 App Key 可以绑 IP 白名单。绑了以后只有白名单里的 IP 能发消息；Cloudflare Worker 的出网 IP 是共享的、不固定、也加不进去，于是网站直接拨号永远拿到
`spug_403 请求IP: 162.159.98.122 不在IP白名单内`。

**解法**：把"最后那一次 HTTP 拨号请求"交给电脑发 —— 出口 IP 就是这台电脑的 IP（也就是白名单里那个）。

```
监听器 → 网站（只决定要不要打：总开关 / 时间段 / 防轰炸）→ 队列 outbox:v1
      → 电脑端执行器 GET /api/outbox 领任务
      → 本机直连 Spug 拨号（trust_env=False，绝不走代理，否则出口 IP 变成代理的）
      → POST /api/outbox/result 回报 → 网站写日志 / 电话健康快照 / 备用 Webhook
```

**怎么开**

1. 网页「电话面板 → 拨打方式」选 **电脑端拨号（用你电脑的 IP）**，保存。
2. 正常启动监听器（`start.bat`）—— 它启动时自动拉起执行器（`bridge.start_executor()`），
   每 3 秒问一次网站有没有要拨的电话；日志里会有一行「电脑端拨号执行器已启动」。
3. 面板上的标签变成 **`执行器：在线 · 出口 IP 182.46.51.186`**：把这个 IP 填进
   Spug 控制台 → 个人设置 → IP 白名单（只认这台电脑当前的实际出网 IP）。
4. 点「📞 测试电话」：会先看到「已排队，电脑端几秒内会拨出」，随后电话由电脑拨出。
5. 想知道真实出口 IP：执行器每次领任务时会把对端看到的 IP 记进 `executor:v1`，
   网页标签、`GET /api/health → phone.executor.ip`、`GET /api/outbox → seenIp` 都能看到。

**要点**

- 拨号请求**不走代理**（执行器里写死 `trust_env=False` + `proxies={None}`）；其它流量（监听器 → 网站）照旧按 `notify.use_proxy` 走。
- 执行器没在线时，网站**不会**谎报成功：排队返回 `reason: "no_executor"`、面板提示「已排队，等执行器上线」，任务留在队列里（租约 90 秒，过期自动可再领）。
- 队列深度上限 100 条；网站自己拨（`site` 模式）时执行器只发心跳、不领任务、不拨号（切回 `pc` 模式，残留任务照样会被拨出去）。
- 电脑端手动自测（不进队列、直接拨一通）：
  ```bash
  py -3 dial_executor.py --config config.json --status   # 看队列 / 执行器状态
  py -3 dial_executor.py --config config.json --once     # 领一轮任务（没有就退出）
  py -3 dial_executor.py --config config.json --dial "测试" "正文"   # 真拨一通
  ```
- `config.json → notify` 里的开关：`dial_executor`（默认 `true`）、`dial_poll_interval`（默认 3 秒）、`dial_batch`（一次领几条，默认 5）。

---

## 5. 部署到 Cloudflare

### 第 0 步：先把代码推到 GitHub

仓库：`https://github.com/qw123888/fictional-spoon`

**方式一（一条命令）**：双击 `push-github.bat`，粘贴 GitHub PAT 即可。
没令牌就去 https://github.com/settings/personal-access-tokens/new 建一个
（Fine-grained：Repository access 选 `fictional-spoon`，Permissions → Contents = **Read and write**；
或用经典令牌 https://github.com/settings/tokens/new 勾 `repo`）。令牌只用于这一次 `git push`，
不会写进 `.git/config`。

**方式二（网页手动上传）**：把仓库文件拖到 GitHub 的 Add file → Upload files 页面。
⚠ **不要拖 `.dev.vars`、`local/data/`、`node_modules/`** —— 里面是真实密钥；
`git archive` 出来的 `上传包.zip` 只含该传的文件，解压后拖它就行。

**方式三（`git push` 连不上 github.com 时用）**：双击 `push-github.bat` 报
`Failed to connect to github.com:443` / `Connection was reset` 时，改用 REST API 推送：

```powershell
powershell -ExecutionPolicy Bypass -File push-github-api.ps1 -Token ghp_xxx
```

它走 `api.github.com`（不依赖 github.com 的 443 直连），只把**和远端不同的文件**用
blobs → tree → commit → 更新分支 的方式推上去，同样会做密钥扫描。注意：它不改本地 HEAD，
所以本地提交历史和远端是两条并行线，下次用 `git push` 前先 `git pull --rebase`。

### 方式 A（推荐，推上去就自动部署）：Cloudflare 连你的 GitHub 仓库

1. Cloudflare 控制台 → **Workers & Pages** → 创建 → Workers → **连接到 Git** → 选 `fictional-spoon`，分支 `main`
2. 构建命令留空，部署命令 `npx wrangler deploy`（仓库根有 `wrangler.toml`，CF 会自动识别）
   仓库里的 `[[kv_namespaces]]` **已经填好了**（binding `NOTIFY_KV`，id `8e6e7c1d2b2b47cba49e1911275903d2`），
   推上去就会自动绑定，配置能持久化（`*.workers.dev` 上 Cache API 不生效，不绑 KV 就存不住）。
   换账号/换命名空间时把那个 `id` 换成自己的 **Storage & Databases → KV** 里的 Namespace ID 再 push；
   也可以不改文件，直接在 Worker → Settings → Bindings → Add → KV namespace 加一个变量名 `NOTIFY_KV` 的绑定
   （**改完立即生效，不用重新部署**；代码两种绑定名都认）。
3. Worker → **Settings → Variables and Secrets** 加三项，类型选 **Secret**：
   `SPUG_APP_KEY`、`SPUG_DEV_TOKEN`、`SIGNAL_TOKEN`（`SIGNAL_TOKEN` 自己定，电脑端用同一个）
4. 部署完拿到 `https://phone-notify.<你的子域>.workers.dev`

### 方式 B（本地 CLI 部署）

```bash
npm install
npx wrangler login                                   # 浏览器授权（一次性）

npx wrangler kv namespace create NOTIFY_KV           # 复制返回的 id
#   把 id 填进 wrangler.toml 的 [[kv_namespaces]].id

npx wrangler secret put SPUG_APP_KEY                 # 粘贴 App Key
npx wrangler secret put SPUG_DEV_TOKEN               # Spug「开发者 Token」：查余额/发送状态（可选但推荐）
npx wrangler secret put SIGNAL_TOKEN                 # 自己定一串令牌，电脑端用同一个

npx wrangler deploy                                  # → https://phone-notify.<子域>.workers.dev
```

### 方式 C：Pages（也是连 Git）

Workers & Pages → Pages → 连接到 Git → 框架预设 **None**、构建命令**留空**、输出目录 `public`
→ Settings → Functions → KV 命名空间绑定（变量名 `NOTIFY_KV`）
→ Settings → 环境变量加 `SPUG_APP_KEY` / `SPUG_DEV_TOKEN` / `SIGNAL_TOKEN`（都勾加密）。
入口已备好 `functions/api/[[route]].js`，`public/_routes.json` 让只有 `/api/*` 走函数、其余走静态资源。

> 三种方式**选一个**就行，别同时开（会各跑一份，日志和配额会互相干扰）。
> 部署后把 `config.json` 的 `notify.site_url` 换成线上地址，再在监听器里点一次「📞 测试电话」。

补充：

- **配置想存住，必须绑 KV**（三级降级：`KV → 边缘缓存(Cache API) → 内存`）。
  Cloudflare 文档明确写了 **Cache API 在 `*.workers.dev` 上不生效**（自定义域名 / Pages 才生效），
  所以跑在 `xxx.workers.dev` 又没绑 KV 时，后端会如实报告成「内存（临时）」，
  点「保存配置」返回 `ok:false / not_persisted`，控制台顶部弹红条告诉你绑 KV 的三步，
  而不是假装保存成功。**本仓库的 `wrangler.toml` 已经带上了 KV 绑定**
  （binding `NOTIFY_KV`，id `8e6e7c1d2b2b47cba49e1911275903d2`），推上去后 `/api/health` 里
  `storage.backend` 应显示 `cloudflare-kv`。换命名空间的话：
  ① **Storage & Databases → KV → Create namespace**（名字随意）；
  ② 本 Worker → **Settings → Bindings → Add → KV namespace**，Variable name 填 `NOTIFY_KV`，选刚建的空间；
  ③ 回控制台再点一次「保存配置」。
- **浏览器草稿兜底**：每次点保存都会把配置存一份到本浏览器 `localStorage`。服务器端存不住时，
  刷新页面会用这份草稿回填表单（顶部红条标注「本浏览器草稿」）并自动重发一次，
  所以不会再出现"刷新就得重新填"。服务器能存住、但本地还留着不一样的旧草稿时，
  底部保存栏会出现「用草稿回填（时间）」按钮，点了才填进表单（不会偷偷覆盖服务器配置）。
- **顶栏有总开关**：页面右上角「电话通知」开关点一下**立刻生效**（走 `/api/switch`，只改 `enabled` 一个字段，
  不会碰你正在改的表单），关掉后所有自动通知都停，只有「测试电话」和带 `force` 的信号能拨。
  切换失败或存不住时开关会弹回服务器真实状态并给红字提示，不会显示成一个骗人的「已关」。
- **时间段有总开关**：右侧「时间段」面板里的开关关掉后，不再看星期与区间，任何时间都可拨打
  （通知总开关与「防轰炸」仍然生效）。配置面板按「操作 / 时间段 / 防轰炸 / 电话接口 / 备用通道 / 令牌」分页，
  改动会在底部保存栏显示「有未保存的改动」，随时可 `Ctrl+S` 保存。
- **令牌优先级**：环境变量 `SIGNAL_TOKEN` > 控制台里保存的令牌。部署时用 secret 下发更安全，
  浏览器端只要在「访问令牌」里填同样的值即可（本地 localStorage 保存，不落库）。
- **浏览器授权有提示**：站点设了 `SIGNAL_TOKEN` 而浏览器没带令牌时，页面左上会常驻一条红条
  （写明服务端返回的是 `令牌无效或缺失`，并在原地给输入框），粘一次就生效；
  也可以用 `https://你的域名/?token=你的令牌` 打开一次自动授权（地址栏随后自动擦掉令牌）。
- 想绑自定义域名：Cloudflare 控制台 → Workers → 该项目 → Settings & Domains & Routes → Add。

---

## 6. 接口一览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/ping` | 否 | 存活探测 |
| GET | `/api/health` | 否 | 状态快照：时间段、配额、存储、通道、电话最近一次结果 |
| POST | `/api/signal` | 是 | **信号接收接口**，电脑端唯一入口。`{kind,title,content,source,id,force}` |
| POST | `/api/test-call` | 是 | 测试电话（`force`，绕过时间段与去重，不占配额） |
| POST | `/api/probe` | 是 | 通道自检（对电话通道只做「不拨号」的可达性验证） |
| GET | `/api/balance` | 是 | **资源查询**：剩余语音分钟数 / 余额 / 短信 / 邮件（需开发者 Token） |
| GET | `/api/status?requestId=` | 是 | 按 `requestId` 查这条通知在各通道的实际发送结果（需开发者 Token） |
| GET/POST | `/api/switch` | 是 | **总开关**：`GET` 读状态；`POST {on:true|false}` 直接设定、`{toggle:true}` 取反。也可用别名 `{enabled:false}` / `{value:false}`。一次只改 `enabled`，**不会顺带覆盖整份配置** |
| GET/POST | `/api/config` | 是 | 读/改配置（App Key 与开发者 Token 回传掩码，填回掩码不会清空真值） |
| POST | `/api/auth/token` | 视情况 | 设置站点令牌 |
| GET | `/api/auth/check` | 否 | 当前令牌是否有效 |
| GET | `/api/logs?limit=` | 是 | 最近通知日志 + 统计 |
| POST | `/api/logs/clear` | 是 | 清空日志 |
| GET | `/api/adapters` | 是 | 已注册的通道适配器列表 |
| GET | `/api/outbox?claim=1&limit=5` | 是 | **电脑端拨号队列**：执行器领任务（`claim=0` 只看不领）。同时记录执行器心跳与"它看到的 IP" |
| POST | `/api/outbox/result` | 是 | **执行器回报拨号结果**：`{id,ok,reason,detail,requestId,ms,status,host}` → 网站写日志 / 健康快照 / 备用通道 |

`/api/signal` 返回统一结构：

```json
{ "ok": true, "skipped": false, "reason": "", "detail": "", "requestId": "…",
  "attempts": 1, "ms": 420, "kind": "phone", "source": "discord", "logId": "…",
  "window": { "active": true, "detail": "…" }, "fallback": null }
```

被时间段/去重/配额拦下时 `ok:false, skipped:true`，`reason` 取
`outside_window` / `duplicate` / `rate_limited` / `hourly_quota` / `daily_quota` / `disabled` / `unknown_channel` / `invalid_signal`。

**总开关**（`enabled`）与其它限制的区别：它是唯一的「一键熔断」——关掉之后除 `force` 信号外一律不拨号
（`reason: "disabled"`），测试电话走的就是 `force`，所以关着也能自测。切换动作会写进日志表（谁在什么时候关的，查得到）。
界面上有两个入口：页面**顶栏**那个开关点一下立刻生效（走 `/api/switch`，一次请求只改这一个字段）；「操作」面板里的同名开关属于整份配置，要跟着「保存配置」一起提交。
命令行也能切：

```bash
curl -X POST https://你的域名/api/switch -H "X-Auth-Token: 你的令牌" \
     -H "Content-Type: application/json" -d '{"on":false}'   # 立刻停掉全部自动电话通知
```

**防轰炸默认值按 Spug 语音通道自身的限流设定**（改大就会撞平台流控，那通电话不会响、还会静默返回成功）：

| 参数 | 默认 | 依据 |
| --- | --- | --- |
| `guard.dedupeSeconds` | 60 | 同一条消息指纹 60s 内只打一次 |
| `guard.minIntervalSeconds` | 60 | Spug：1 通/分钟 |
| `guard.maxPerHour` | 5 | Spug：5 通/小时 |
| `guard.maxPerDay` | 20 | Spug：20 通/天（超了 `xsend` 仍回 `code:200`，查状态才是 `status=3 触发流控`） |

`force`（`/api/test-call`、`/api/signal` 带 `force:true`）绕过时间段与防轰炸，也不占额度。

---

## 7. 扩展新功能（只用接口/模块，不碰主流程）

新增一个通道 = 写一个适配器 + 注册进去，`CommModule.notify()` 立刻能用：

```js
import { ChannelAdapter } from "../channel.js";

class SmsAdapter extends ChannelAdapter {
  constructor(cfg) { super("sms", { label: "短信", description: "短信通道" }); this.cfg = cfg; }
  get kind() { return "sms"; }
  async send(payload, ctx) { /* 调你的短信 API，返回 {ok, retryable, reason, detail} */ }
  async probe(ctx) { /* 只验可达性，不发真实短信 */ }
}

comm.register(new SmsAdapter(cfg));   // 非 ChannelAdapter 实例会被拒绝
```

信号端的 `kind` 就是通道名，`/api/signal` 无需改动；配置合并、日志、时间段、防轰炸、
重试、兜底全部由 `CommModule` 统一负责。

---

## 8. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `spug_403` + `请求IP: 162.159.98.122 不在IP白名单内` | **Cloudflare 的出网 IP，加不进白名单**。改用「电脑端拨号」：网页电话面板把「拨打方式」切成 *电脑端拨号*，启动监听器（自动拉起执行器），把这个标签里的电脑出口 IP 加进 Spug 白名单。见 §4.4。 |
| 面板显示 `执行器：未连接` / 返回 `reason: "no_executor"` | 监听器的拨号执行器没跑起来。启动 `start.bat`（日志应有「电脑端拨号执行器已启动」）；若没有，检查 `config.json → notify.dial_executor` 是不是 `false`，以及 `dial_executor.py` 是否和监听器在同一目录。任务不会丢，执行器上线后几秒内就会拨出去。 |
| 面板显示 `执行器：离线（N 分钟前在线过）` | 电脑端进程退出了（关掉窗口 / 关机）。重新启动即可；队列里的任务会等它回来。 |
| `spug_403` + `请求IP: 1.2.3.4 不在IP白名单内`（电脑端拨号也报） | 这台电脑现在的出网 IP 和白名单里写的不一样（换了网络 / 代理客户端在抢路由）。看面板标签里的「出口 IP」，把它更新进 Spug 白名单。注意执行器**不走代理**，代理开着也不影响它的出口 IP。 |
| `spug_400` + `因应用key限制，无可用通道` | 这个 App Key 的通道权限范围里没有你在 `channel` 里指定的通道。到 Spug 控制台改该 App Key 的授权通道，或换一个 Key。 |
| 接口报 `Invalid data type for parse` | 请求体带了 **UTF-8 BOM**（PowerShell `Set-Content -Encoding UTF8` 会写 BOM）。用无 BOM 的 UTF-8 重发即可；页面与 Node/Python 代码不受影响。 |
| 电话打了但对方没接到 / `status=3` `此号码触发流控` | 撞上 Spug 语音通道自身的限流：**1 通/分钟、5 通/小时、20 通/天**（按号码）。此时 `xsend` 仍返回 `code:200`，只有查发送状态才看得到 —— 所以站点侧默认值已按此对齐（见 §4），撞限流的那通**不计费**。 |
| `spug_400` + `请求参数缺失：title` | 这是**自检**的正常返回，说明域名可达、App Key 格式正确（自检故意不带参数，因此不会真的拨号）。 |
| 电话不响、`code` 提示手机号未授权 | Spug 要求机主先完成「防骚扰授权」（扫码后发短信确认），否则语音通道对该号码不可用。 |
| `code` 提示渠道未开启 / App Key 未授权 | 在 Spug 控制台开启 voice 通道，并确认 App Key 的权限范围包含语音。 |
| 被手机系统拦截 | Spug 语音主叫号：`021 31443892`、`021 32199761`、`0371 55969643`，可加白名单或关拦截。 |
| 网页显示「内存（临时）」/ 顶部红色「配置存不住」 | 没有绑定 KV。跑在 `*.workers.dev` 时 Cache API 不生效（Cloudflare 文档有明确说明），所以只有内存可用 —— 保存会返回 `not_persisted`。按红条三步绑 KV 即可，不用改代码、不用重新部署。 |
| **点「保存配置」没反应 / 刷新页面配置又变回默认** | 老版本后端是内存存储、且接口无条件返回 `ok:true`（假装保存成功）。现已修复：点保存有明确反馈（`已保存 HH:MM:SS` / `没存住：…` + 顶部红条 + 按钮状态），没绑 KV 时还会用**本浏览器草稿**回填（刷新不用重填）。要真正生效到服务器，绑 KV（见上）。 |
| 网页 401 / 页面显示「缺失或者无效」/ 保存和测试电话都被拒 | 浏览器没带令牌 —— **不是电话接口没配好**。两种授权方式：① 页面顶部红色条里直接粘贴 `SIGNAL_TOKEN` 点「应用」；② 用带令牌的链接打开一次：`https://你的域名/?token=你的令牌`（授权后地址栏会自动擦掉令牌，令牌存在本浏览器）。授权后红条会自己消失、配置表单会被填上。另外确认浏览器「访问令牌」里的值与环境变量 `SIGNAL_TOKEN` 一致（环境变量优先）。 |
| 剩余语音显示「查询失败 / 未配置开发者 Token」 | 查余额和发送状态**只能**用 Spug 控制台的「开发者 Token」（App Key 不行）：填到控制台「电话接口参数 → 开发者Token」，或 `wrangler secret put SPUG_DEV_TOKEN`。 |
| 剩余语音 0 分钟 | 语音是计费通道，去 Spug 控制台充值或买语音资源包；控制台会在 ≤3 分钟时弹红色提醒。 |
| 电脑端 401 | `config.json → notify.token` 与站点令牌不一致。 |
| `git push` 报 `Failed to connect to github.com:443 ... Could not connect to server` / `Connection was reset` | 本机到 `github.com:443` 被间歇性重置（DNS 抽风或链路阻断），**和令牌无关**：`api.github.com` 正常就说明令牌没问题。三种办法：① 改用 `push-github-api.ps1`（走 `api.github.com`，见 §5 第 0 步方式三）；② 在 `%WINDIR%\System32\drivers\etc\hosts` 里写 `<可用IP> github.com`（可用 IP：`140.82.113.3`、`140.82.114.3`、`20.27.177.113`）+ `ipconfig /flushdns`；③ 网页手动上传。 |
| 时间段不对 | 检查 `window.tz`（默认 `Asia/Shanghai`）、`mode`（`inside`=只在时段内拨 / `outside`=只在时段外拨）、星期与区间；跨天写 `["22:00","06:00"]`。 |

---

## 9. 安全

- App Key、开发者 Token、令牌只放服务端：`wrangler secret` 或本地 `.dev.vars`（已 gitignore），**不进仓库、不进前端**。
- 控制台里 App Key 与开发者 Token 一律以掩码展示；填回掩码不会覆盖真实值。
- 保存配置时以「库里的配置」为合并基线，**环境变量里的密钥不会被回写进 KV**。
- 未配置令牌时站点对所有人开放，只适合本地调试；部署后务必设置 `SIGNAL_TOKEN`。
