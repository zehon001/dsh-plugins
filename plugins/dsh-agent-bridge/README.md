# DSH Agent 桥接插件

包名 `dsh-agent-bridge`。

让 **DSH 内部（Agent 工具层）** 与 **外部第三方工具（HTTP API 层）** 都能编排 DSH 的工作区与会话，并在会话完成时获得**实时通知**。

```text
主会话 ──┬─> 子会话 A（任务1）──完成──> 通知主会话
         ├─> 子会话 B（任务2）──完成──> 通知主会话
         └─> 子会话 C（任务3）──完成──> 通知主会话
第三方工具 ───> 主会话 ── 完成 ──> 通知第三方工具
```

插件提供三层能力，对应同一套编排语义：

| 层 | 使用方 | 交付方式 |
|---|---|---|
| **Agent 工具** | DSH 内部会话（模型自动调用） | `orchestrator_*` 工具自动进入系统提示 |
| **REST API** | 外部第三方工具 / 脚本 | `http://<host>:<port>/api/orchestrator/*` |
| **实时事件** | 外部工具 / 页面 | SSE（`GET /events`）+ Webhook（POST 回调） |

完成通知的三种去向可同时生效：

1. **SSE 推送** —— `session.completed` 事件实时到达已连接的订阅者；
2. **Webhook 回调** —— 创建会话时携带 `callbackUrl`，或注册全局 hook；
3. **父会话唤醒** —— 若会话由主会话（或其工具）创建，完成时向父会话注入一条
   用户角色通知并唤醒它继续处理结果。

---

## 目录

- [能力清单](#能力清单)
- [安装](#安装)
- [快速开始（第三方工具视角）](#快速开始第三方工具视角)
- [快速开始（主会话视角）](#快速开始主会话视角)
- [REST API 参考](#rest-api-参考)
- [SSE 事件参考](#sse-事件参考)
- [Webhook 回调](#webhook-回调)
- [Agent 工具参考](#agent-工具参考)
- [认证](#认证)
- [配置](#配置)
- [安全模型](#安全模型)
- [故障排查](#故障排查)

---

## 能力清单

| 需求 | 实现 |
|---|---|
| 读取工作区 | `GET /api/orchestrator/workspaces` · 工具 `orchestrator_list_workspaces` |
| 创建工作区 | `POST /api/orchestrator/workspaces` · 工具 `orchestrator_create_workspace` |
| 读取工作区对话列表 | `GET /api/orchestrator/workspaces/:id/sessions` · 工具 `orchestrator_list_sessions` |
| 在工作区创建对话 | `POST /api/orchestrator/sessions` · 工具 `orchestrator_create_session` |
| 读取对话运行状态 | `GET /api/orchestrator/sessions/:id` · 工具 `orchestrator_session_status` |
| 挂靠会话到工作区 | `POST /api/orchestrator/workspaces/:id/attach` |
| 删除工作区登记 | `DELETE /api/orchestrator/workspaces/:id` |
| 归档会话 | `POST /api/orchestrator/sessions/:id/archive` |
| 恢复父子通知关系 | `POST /api/orchestrator/relations` |
| 监听对话执行状态 | `GET /api/orchestrator/events`（SSE：status / turn-start / turn-end / completed） |
| 对话完成实时通知 | SSE + Webhook + 父会话 followup 三通道 |

额外提供：读取对话消息与最终回复、向会话追加消息、取消运行、阻塞等待完成、
会话级/全局 Webhook 注册。

---

## 安装

插件是标准 DSH 第三方插件包（`dsh.bundle.patch` + `cordis.patch.yml`）。
把它安装进任意 **profile** 即可，宿主半侧无需浏览器 UI。

### Windows（DSH CLI）

在 DSH 终端中执行。首次安装时，从内置 Web 模板新建 `blueprint-studio` profile：

```powershell
dsh --profile blueprint-studio --from-default-profile web --dump-default-config | Out-Null
$bridgePath = (Resolve-Path -LiteralPath '<dsh-agent-bridge 源码目录>').Path -replace '\\','/'
dsh plugin --profile blueprint-studio add "file:$bridgePath"
```

如果这个 profile 的 pnpm 关闭了 peer 自动安装，使用和宿主发行版匹配的包补齐依赖。
以下命令对应 Windows DSH `0.2.2-rc.1`：

```powershell
$release = '0.2.2-rc.1'
$harnessPackages = 'llm', 'session', 'tools', 'scope', 'agent', 'system-prompt', 'user-approval',
    'session-projection', 'typert-protocol', 'util-values', 'brand' |
    ForEach-Object { "@deepseek-ai/dsh-$_@$release" }
dsh plugin --profile blueprint-studio add --save-exact '@deepseek-ai/cordis@4.1.0' '@deepseek-ai/schemastery@3.19.0' @harnessPackages
dsh plugin --profile blueprint-studio peers check
```

为 DSH Web 和桥接服务分别分配端口。在该 profile 的 `cordis.patch.yml` 中设置桥接端口，
并为 `apiToken` 生成独立的随机密钥：

```yaml
- id: dsh-agent-bridge
  config:
    host: 127.0.0.1
    port: <桥接端口>
    apiToken: '<随机长字符串>'
```

用 `dsh --profile blueprint-studio --host 127.0.0.1 --port <DSH Web 端口> --no-open`
启动该 profile。Studio 使用 `BP_DSH_PROFILE=blueprint-studio` 和
`BP_DSH_URL=http://127.0.0.1:<桥接端口>` 连接。

### macOS 桌面端

```bash
bash scripts/install-desktop.sh
```

安装脚本将本地包加入桌面 profile 的依赖和 `dsh.profile.bundles`，并重新安装依赖。
修改后重启桌面 DSH 以加载更新。

### 验证加载

```bash
TOKEN=$(python3 - <<'PY'
import re, os
text = open(os.path.expanduser('~/.dsh/profiles/desktop/cordis.patch.yml')).read()
m = re.search(r"- id: dsh-agent-bridge\n  config:\n(?:    .*\n)*?    apiToken: '([^']+)'", text)
print(m.group(1) if m else '')
PY
)
curl -H "x-api-token: $TOKEN" http://127.0.0.1:49301/api/orchestrator/health
# {"ok":true,"plugin":"dsh-agent-bridge","version":"0.2.0","port":49301,"toolsMounted":true,...}
```

### 独立 HTTP 服务

插件自建独立回环 HTTP 服务（默认 `127.0.0.1:49301`），不注册到 DSH 原生 webServer。
端口固定，外部工具直接访问；`host` / `port` 可在配置中覆盖。

---

## 快速开始（第三方工具视角）

第三方工具通过独立 HTTP 服务访问：`http://127.0.0.1:49301`，认证使用插件配置的
`apiToken`（`x-api-token` 头或 `Authorization: Bearer <token>`）。

### 1. 创建工作区并投放任务

```bash
BASE=http://127.0.0.1:49301/api/orchestrator
TOKEN=<插件配置的 apiToken>

# 创建工作区（目录不存在时自动创建）
curl -s -H "x-api-token: $TOKEN" -X POST $BASE/workspaces \
  -H 'content-type: application/json' \
  -d '{"path":"/Users/me/work/demo","title":"演示工作区"}'

# 在工作区中创建对话并立即下发任务
curl -s -H "x-api-token: $TOKEN" -X POST $BASE/sessions \
  -H 'content-type: application/json' \
  -d '{
        "workspaceId":"<workspaceId>",
        "prompt":"统计 src 目录下文件数量并给出结论",
        "title":"文件统计"
      }'
# → {"ok":true,"sessionId":"session-...","promptAccepted":true}
```

### 2. 实时监听完成（SSE）

```bash
curl -N -H "x-api-token: $TOKEN" $BASE/events
# event: session.completed
# data: {"type":"session.completed","sessionId":"session-...","title":"文件统计",
#        "outcome":"completed","reason":"completed","durationMs":18234,
#        "summary":"共 128 个文件…","toolCalls":3}
```

### 3. 也可用阻塞等待

```bash
curl -s -H "x-api-token: $TOKEN" -X POST $BASE/sessions/<id>/wait \
  -H 'content-type: application/json' -d '{"timeoutMs":120000}'
# {"ok":true,"sessionId":"session-...","idle":true,"status":"idle"}
curl -s -H "x-api-token: $TOKEN" $BASE/sessions/<id>/result
# {"ok":true,"sessionId":"session-...","result":"共 128 个文件…"}
```

---

## 快速开始（主会话视角）

模型无需手动调用 HTTP —— 插件把编排能力注册成 **模型可见工具**。
主会话只要表达"并行拆分任务"，模型就会用 `orchestrator_create_session`
创建子会话；每个子会话完成时，主会话会收到一条注入消息并被唤醒：

```text
[orchestrator] 子会话已完成（completed, reason=completed）。
- 子会话: 文件统计 (id: session-...)
- 轮次: 1，耗时 18.2s
- 最后回复:
共 128 个文件…

可用 orchestrator_read_result 获取完整结果，或继续编排其他子会话。
```

> 通知以用户角色消息注入，来源标记为 `orchestrator`，不影响模型对历史的正常理解。
> 主会话正忙时（例如正在 `orchestrator_wait_sessions`），通知排队到下一轮送达。

---

## REST API 参考

所有端点前缀 `/api/orchestrator`，响应均为 JSON：成功 `{ "ok": true, ... }`，
失败 `{ "ok": false, "error": { "code": "...", "message": "..." } }`。

### 工作区

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/workspaces` | 列出全部工作区 |
| `GET` | `/workspaces/:id` | 读取单个工作区 |
| `POST` | `/workspaces` | 创建/复用工作区 |
| `GET` | `/workspaces/:id/sessions` | 该工作区内的对话列表（含运行状态） |
| `POST` | `/workspaces/:id/attach` | 把既有会话挂靠进工作区（cwd 必须等于工作区路径） |
| `DELETE` | `/workspaces/:id` | 删除工作区登记（保留目录与会话日志；未知 id 幂等） |

`POST /workspaces` 请求体：

```json
{ "path": "/abs/dir", "title": "可选标题", "createDirectory": true }
```

- `path` 必填，可以是绝对路径；相对路径按宿主进程工作目录解析。
- `createDirectory` 默认 `true`：目录不存在时递归创建。
- 相同规范化路径重复调用返回既有工作区，不会改标题。

工作区对象：

```json
{ "workspaceId": "…", "path": "/abs/dir", "title": "…",
  "sessionIds": ["session-…"], "createdAt": "ISO", "updatedAt": "ISO" }
```

### 会话

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/sessions` | 全部对话列表 |
| `GET` | `/sessions/:id` | 运行状态（`status`/`running`/`lastTurn`） |
| `GET` | `/sessions/:id/messages?limit=50` | 消息视图（user / assistant 文本） |
| `GET` | `/sessions/:id/result` | 最后一条 assistant 回复 |
| `POST` | `/sessions` | 创建对话（可绑定工作区、发首条消息、登记回调） |
| `POST` | `/sessions/:id/prompt` | 追加一条用户消息 |
| `POST` | `/sessions/:id/cancel` | 取消当前运行 |
| `POST` | `/sessions/:id/wait` | 阻塞等待空闲完成 |
| `POST` | `/sessions/:id/archive` | 归档会话（从工作区导航隐藏，可重建同名） |
| `POST` / `GET` | `/relations` | 登记/列出「子→父」通知关系（宿主重启后内存映射丢失，用于恢复唤醒链） |

`POST /sessions` 请求体：

```json
{
  "workspaceId": "可选；与 cwd 二选一",
  "cwd": "/abs/dir",
  "title": "可选标题",
  "agentPreset": "可选 Agent 预设",
  "prompt": "可选首条任务消息",
  "callbackUrl": "可选；完成时 POST 到该 URL",
  "notifySessionId": "可选；完成时唤醒该会话并发通知"
}
```

响应：

```json
{ "ok": true, "sessionId": "session-…", "agentPreset": "standard", "promptAccepted": true }
```

`GET /sessions/:id` 状态对象：

```json
{
  "sessionId": "session-…",
  "status": "idle | running | unknown | not-found",
  "running": false,
  "agentAvailable": true,
  "title": "…",
  "cwd": "/abs/dir",
  "parentSessionId": "可选：编排父会话",
  "lastTurn": { "turn": 1, "outcome": "completed", "reason": "completed",
                "durationMs": 1689, "endedAt": "ISO" }
}
```

`POST /sessions/:id/wait` 请求体 `{ "timeoutMs": 60000 }`（也可用 query 参数），
响应 `{ "ok": true, "idle": true, "status": "idle" }`；超时返回
`{"idle":false,"status":"running","timedOut":true}`。

`POST /sessions/:id/prompt` 请求体 `{ "text": "…", "requestId": "可选幂等 id", "mode": "steer" }`。

`POST /sessions/:id/model` 请求体 `{ "provider": "提供方 id", "model": "模型 id", "reasoningEffort": "可选思考强度" }` —— 为会话选择模型（sessionController.selectModel：对下一次请求生效并回存默认）。

### Webhook 管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/hooks` | 注册全局 Webhook：`{ "url": "http(s)://…" }` |
| `DELETE` | `/hooks` | 清空全局 Webhook |

### 其他

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/livez` | 最小存活检查（无需 token） |
| `GET` | `/health` | 健康检查 + 监听信息 + 工具名 |
| `GET` | `/capabilities` | 能力目录（模型 / 思考强度 / 权限预设 / 默认值，由宿主配置解析） |
| `GET` | `/events` | SSE 实时事件流 |

会话补充端点：`POST /sessions/archive-all`（批量归档，可带 `workspaceName`）、
`GET /sessions/:id/page`（assistant/message + turn/end 分页视图）。

错误码：`gateway/bad-request`(400)、`unauthorized`(401)、
`workspace/not-found` / `session/not-found`(404)、
`session/agent-busy`(409)、`internal`(500)。

---

## SSE 事件参考

`GET /api/orchestrator/events` 返回 `text/event-stream`。每条事件形如：

```text
event: <type>
data: {"type":"<type>", ...payload}
```

| 事件 | 时机 | 主要字段 |
|---|---|---|
| `ready` | 连接建立 | `clients` |
| `session.created` | 会话创建 | `sessionId, title, cwd` |
| `session.removed` | 会话关闭 | `sessionId` |
| `session.status` | 运行状态变化 | `sessionId, status, running` |
| `session.turn-start` | 一轮开始 | `sessionId, turn` |
| `session.turn-end` | 一轮结束 | `sessionId, turn, reason, outcome, durationMs` |
| `session.completed` | **成功完成并空闲** | `sessionId, title, turn, outcome, reason, durationMs, summary, toolCalls, timestamp` |
| `session.interrupted` | 非成功终态（取消/阻塞/超限） | 同上，`outcome` 为 `interrupted`/`blocked`/`max-tokens` |
| `session.failed` | Agent 执行异常 | `sessionId, reason, error{code,message}` |
| `workspace.changed` | 工作区注册表变化 | — |

`outcome` 取值：`completed` / `blocked` / `max-tokens` / `interrupted` / `unknown`。
`reason` 保留宿主原始 `turn/end` 原因（`completed`、`user`、`disposed`、`hook`…）。

心跳：每 25s 发送 `: ping` 注释行，用于穿透反向代理。

---

## Webhook 回调

完成/中断/失败时向注册的 URL 发送 `POST`：

```http
POST /dsh-done
content-type: application/json
x-dsh-orchestrator-event: session.completed

{"event":"session.completed","sessionId":"session-…","title":"…",
 "turn":1,"outcome":"completed","reason":"completed","durationMs":18234,
 "summary":"…","toolCalls":3,"timestamp":1793331097818}
```

- 注册方式：`POST /sessions` 的 `callbackUrl`（会话级）、`POST /hooks`（全局）、
  或工具 `orchestrator_set_webhook`。
- 超时由配置 `webhookTimeoutMs` 控制（默认 8s）；失败仅记录日志，不重试、不阻塞宿主。
- 事件类型：`session.completed`、`session.interrupted`、`session.failed`。

---

## Agent 工具参考

模型在系统提示中自动获得这些工具（可通过 `enableTools: false` 关闭）：

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `orchestrator_list_workspaces` | 列出工作区 | — |
| `orchestrator_create_workspace` | 创建工作区 | `path`, `title?`, `create_directory?` |
| `orchestrator_list_sessions` | 列出会话（可按工作区） | `workspace_id?` |
| `orchestrator_create_session` | **创建子会话并下发首条任务** | `prompt`, `workspace_id?` / `cwd?`, `title?`, `agent_preset?`, `notify?` |
| `orchestrator_session_status` | 查询运行状态 | `session_id` |
| `orchestrator_read_result` | 读取最终回复 | `session_id` |
| `orchestrator_prompt_session` | 追加消息 | `session_id`, `text` |
| `orchestrator_wait_sessions` | 阻塞等待完成 | `session_ids[]`, `timeout_ms?` |
| `orchestrator_cancel_session` | 取消运行 | `session_id` |
| `orchestrator_set_webhook` | 注册 Webhook | `url`, `session_id?` |

`orchestrator_create_session` 默认把**当前会话**登记为父会话（`notify: true`），
因此子会话完成时会自动唤醒创建者。

---

## 认证

**所有端点（含 GET 与 SSE）都先认证**，再进入业务逻辑。支持两种通道：

### 通道 A：DSH 浏览器会话 Cookie（默认，零配置）

复用 DSH 自身的安全模型，通过 `connection.requestRejection()` 校验：

1. **Host/Origin 栅栏**：仅接受指向本机监听地址（或受信任 Host）的请求；
   跨站 `Origin`、`sec-fetch-site: cross-site` 一律 403。
2. **浏览器会话 Cookie**：先经 `/connect?token=<启动令牌>` 换取 Cookie。
   启动令牌由 `dsh web` 启动日志打印，桌面端由 GUI URL 的 `?token=` 提供。

```bash
TOKEN=<GUI URL 里的 token>
curl -c cookies.txt "http://127.0.0.1:<port>/connect?token=$TOKEN" -o /dev/null
curl -b cookies.txt "http://127.0.0.1:<port>/api/orchestrator/workspaces"
```

### 通道 B：插件 API Token（适合常驻第三方工具）

在插件配置里设置 `apiToken` 后，请求可携带以下任一凭据（无需先换 Cookie）：

```bash
curl -H "x-api-token: <apiToken>" ...          # 请求头
curl -H "Authorization: Bearer <apiToken>" ... # Bearer
curl "...?token=<apiToken>"                     # 查询参数（SSE/EventSource 常用）
```

配置示例：

```yaml
- id: dsh-agent-bridge
  config:
    apiToken: '请替换为随机长字符串'
```

> Host/Origin 栅栏对 token 通道同样生效：跨站 `Origin` 仍返回 403，因此网页无法
> 借 token 发起跨站请求。若宿主绑定到非环回地址，请务必设置强随机 `apiToken`。

### 其他说明

- **浏览器页面**：与 DSH Web GUI 同源时自动携带 Cookie；插件默认不发送 CORS 头，
  第三方跨域页面只能经由服务端转发访问。
- **安全提示**：Cookie 与 API Token 都等价于本机编排权限，请勿泄露给不可信代码。

---

## 配置

配置位于 profile 的 `cordis.patch.yml`（按 entry id 覆盖）：

```yaml
- id: dsh-agent-bridge
  config:
    enableHttp: true            # 启动独立回环 HTTP 服务
    host: '127.0.0.1'           # 监听地址（仅回环）
    port: 49301                 # 监听端口
    enableTools: true           # 注册 orchestrator_* 模型工具
    apiToken: ''                # 第三方 API Token；空 = 仅允许本机回环访问
    notifyParentSession: true   # 子会话完成时唤醒父会话
    parentNotifyOnInterrupted: true  # 非成功终态也通知父会话
    maxSummaryChars: 4000       # 通知中携带的结果摘要上限
    webhookTimeoutMs: 8000      # Webhook POST 超时
    heartbeatMs: 25000          # SSE 心跳间隔
```

---

## 安全模型

- 插件不绕过宿主权限：工作区/会话读写全部走 DSH 既有服务
  （`workspaceRegistry` / `sessionController`），继承归档、目录校验等约束。
- HTTP 服务只监听回环地址，并在每个请求上再次校验来源地址；
  除 `/livez` 外必须携带插件 `apiToken`（恒定时间比较），请求体上限 1 MiB。
- 父会话通知只唤醒**已存在且活跃**的父会话；不会为通知复活冷会话。
- Webhook 仅允许 `http(s)` URL；失败不重试，避免放大故障。

---

## 故障排查

| 现象 | 排查 |
|---|---|
| 连接被拒绝 | 插件未加载或端口被占用：检查 profile `dsh.profile.bundles`、`cordis.patch.yml`、重启宿主 |
| 401 | `apiToken` 不匹配：检查 profile 中的插件配置与请求头 |
| 403 | 非回环来源：只允许本机访问 |
| `toolsMounted: false` | `tools` 服务不可用或工具 schema 校验失败，查看宿主启动日志 |
| 收不到 SSE 事件 | 确认连接保持（心跳注释行）、代理未缓冲；检查会话是否真正结束 |
| 父会话未收到通知 | 确认创建时 `notify` 未禁用、父会话仍活跃（关闭的会话不会唤醒） |

---

## 开发

```bash
node --check lib/index.js   # 语法检查
```

插件为纯 ESM，无构建步骤；依赖 DSH 宿主解析 `@deepseek-ai/*` 包。

## License

MIT
