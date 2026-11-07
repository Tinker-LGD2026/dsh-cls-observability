# dsh-cls-observability

[English](README.md)

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）0.2.x 的 Agent 运行过程，以 OpenTelemetry Trace 的形式上报到[腾讯云日志服务 CLS AgentObs](https://cloud.tencent.com/document/product/614/136743)。

- **单文件、零依赖**：`dist/dsh-cls-observability.mjs` 是一个 Cordis 插件，在 DSH 任意 patch 层按文件路径加载即可。不需要 `dsh plugin add`，不需要每个 profile 单独安装，Agent 主机上也不需要包管理器。
- **AgentObs 语义**：每个 turn 五层 Span（`entry → agent → step → chat / tool`），字段按 CLS 定义；包含 token 用量、首 token 耗时、工具入参与结果、PTC（`run_code`）内层工具调用、挂在父工具调用下的子 Agent、辅助模型调用（压缩、会话标题、自动审查）、审批与重试。
- **退出不丢数据**：DSH 退出时，未发送的 Span 同步写入本地 outbox，由独立进程补发；仍未送达的在下次启动时补发。
- **不影响宿主**：插件异常不会传给 DSH；不参与 DSH 的会话检查点；配置只读真实进程环境，克隆来的仓库里的 `.env` 无法开启采集、改写上报地址或修改内容采集设置。

> 状态：0.1.0 预览版。尚未覆盖：进程崩溃后未结束 turn 的补全、容器场景的转发进程、内容脱敏、临时密钥（STS）。

## 运行要求

- DeepSeek Harness 0.2.x
- Node.js ≥ 24.9（与 DSH 要求一致）
- 一个 CLS AgentObs Trace 日志主题，以及有该主题写入权限的腾讯云密钥

## 获取插件

从 npm 包（`npm pack dsh-cls-observability`，或 `npm install` 后使用 `node_modules/dsh-cls-observability/dist/dsh-cls-observability.mjs`）或 GitHub Release 获取 `dsh-cls-observability.mjs`，放到 Agent 主机上，例如 `/opt/dsh-cls-observability/dsh-cls-observability.mjs`，并用发布的 `.sha256` 校验。

## 启用

1. 加载插件。对所有 profile 生效：写入 `$DSH_HOME/cordis.patch.yml`（或用 `--patch` 指定文件）：

   ```yaml
   - insert:
       - id: cls-agentobs
         name: /opt/dsh-cls-observability/dsh-cls-observability.mjs
   ```

2. 设置 DSH 进程的环境变量：

   ```bash
   export CLS_AGENTOBS_ENABLED=true
   export CLS_AGENTOBS_REGION=ap-shanghai
   export CLS_AGENTOBS_TOPIC_ID=<Trace 主题 ID>
   export TENCENTCLOUD_SECRET_ID=<SecretId>
   export TENCENTCLOUD_SECRET_KEY=<SecretKey>
   ```

3. 照常运行 DSH（`dsh web`、`dsh headless "…"` 等）。设置 `CLS_AGENTOBS_DEBUG=true` 可以在 stderr 看到插件日志。

运行中的 `dsh web` 在 `$DSH_HOME/cordis.patch.yml` 被修改后会自动加载插件，但前提是 DSH 启动时这个文件已经存在（DSH 0.2.2 不会感知启动后才新建的文件）。如果希望以后不重启就能启用插件，请预先放一个内容为 `[]` 的空 patch 文件。环境变量的变更仍需重启。

### 由程序拉起（TypeScript SDK）

```ts
const harness = new DeepSeekHarness({
  patches: ['/opt/dsh-cls-observability/agentobs.patch.yml'],
  // SDK 的 env 会整体替换子进程环境，需要保留 process.env。
  env: { ...process.env, CLS_AGENTOBS_ENABLED: 'true', CLS_AGENTOBS_REGION: 'ap-shanghai', CLS_AGENTOBS_TOPIC_ID: '…' },
})
```

## 配置

所有变量只从真实进程环境读取。进程环境中设置 `CLS_AGENTOBS_TRUST_USER_ENV=true` 时，也接受 `$DSH_HOME/.env`；项目目录下的 `.env` 始终被忽略。完整列表见 [README.md](README.md#configuration)，常用项：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CLS_AGENTOBS_ENABLED` | – | 设为 `true` 开启 |
| `CLS_AGENTOBS_REGION` / `CLS_AGENTOBS_TOPIC_ID` | – | 地域与 Trace 主题 |
| `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` | – | 密钥；也可用 `CLS_AGENTOBS_CREDENTIALS_FILE` 指定凭证文件（变更后自动重读） |
| `CLS_AGENTOBS_NETWORK` | 公网 | `internal` 使用内网域名 |
| `CLS_AGENTOBS_ENDPOINT` | – | 改为发往其他 OTLP/HTTP 端点（Collector、转发进程） |
| `CLS_AGENTOBS_CAPTURE_CONTENT` | `truncate` | 消息与工具内容：`truncate`（单字段截断到 `CLS_AGENTOBS_CONTENT_MAX_CHARS`，默认 32000）/ `full` / `off` |
| `CLS_AGENTOBS_REDACT` | `on` | 上报前对内容做密钥脱敏（见下文）；`off` 关闭 |
| `CLS_AGENTOBS_REDACT_PATTERNS` | – | 自定义脱敏规则：正则表达式的 JSON 数组，如 `["EMP-\\d{6}"]` |
| `CLS_AGENTOBS_INCLUDE_AUXILIARY` | `true` | 记录压缩、会话标题等辅助模型调用，保证 Token 与成本统计完整；设为 `false` 不采集 |
| `CLS_AGENTOBS_SAMPLE_RATIO` | `1` | 按会话采样 |
| `CLS_AGENTOBS_CUSTOM_ATTRIBUTES` | – | `k=v,k2=v2`，作为 `agent.custom.k` 附在每个 Span 上 |
| `CLS_AGENTOBS_DEBUG` | `false` | stderr 诊断日志 |

`gen_ai.entry.type` 取自 DSH profile：`headless` → `cli`、`web` → `web`、`desktop` → `desktop`、`sdk` / `sdk-minimal` → `sdk`、`acp` → `acp`，自定义 profile 取其名称。profile 名同时记录在 `agent.custom.dsh_profile`。可用 `CLS_AGENTOBS_ENTRY_TYPE` / `CLS_AGENTOBS_ENTRY_PLATFORM` 覆盖。

## 采集内容

| Span | 名称 | 说明 |
|---|---|---|
| entry | `enter_application` | 每个 turn 一个；包含本轮输入与最终答复；`agent.custom.trigger` 区分用户发起与自动续跑 |
| agent | `invoke_agent main` / `invoke_subagent <名字>` | 子 Agent 使用父 Agent 为它起的名字。在父 Trace 内运行的子 Agent 轮次没有 entry，agent 直接挂在启动它的工具调用下 |
| step | `react round_<N>` | 每次模型 step 一个 |
| chat | `chat <模型>` | 用量（含缓存命中、推理 token）、首 token 耗时、结束原因、请求参数。输入在会话首次调用时为全量上下文，之后只上报新增部分（`gen_ai.input.messages_delta`）；`gen_ai.input.messages.hash` 对应完整上下文 |
| tool | `execute_tool <工具名>` | 入参、结果、错误；耗时不含人工审批等待；PTC 内层调用挂在 `run_code` 下 |

Trace 与 Span ID 由会话日志计算得出，同一个 Span 无论发送几次 ID 都相同。投递语义为至少一次：只有在请求已成功、但进程在收到响应前退出时才会产生重复。

### 内容与隐私

默认采集消息与工具内容（截断模式），因为 CLS AgentObs 控制台需要展示 chat 输入输出和工具入参结果。这些内容可能包含用户与工具交换的任何数据。设置 `CLS_AGENTOBS_CAPTURE_CONTENT=off` 后只上报结构、耗时与用量。

内容离开进程前会先脱敏，命中处替换为 `[REDACTED:<规则名>]`，Span 上标注 `agent.custom.content_redacted`，命中的规则记录在 `agent.custom.redacted_types`：

- 私钥、腾讯云 SecretId（`AKID…`）、AWS Access Key、GitHub / GitLab / Slack Token、Google API Key、`sk-…` 形式的 API Key、JWT、`Bearer` / `Basic` 凭证、URL 中的密码；
- 键名表示凭证的 `KEY=value`、`"key": "value"` 赋值（如 `password`、`secret_key`、`api_key`、`token`），以及工具入参中这类键下的值。

脱敏基于规则匹配，能覆盖常见格式，但不能保证识别所有密钥。可用 `CLS_AGENTOBS_REDACT_PATTERNS` 补充自己的格式，或关闭内容采集。

## 开发

```bash
npm install
npm test          # 单元测试 + 回放 DSH 全部会话录像（需要 DSH 源码，见 DSH_REPO）
npm run build     # dist/dsh-cls-observability.mjs + .sha256
```

端到端脚本会运行真实 DSH 任务、上报到 CLS 并回查。需要 DSH 源码（`DSH_REPO`，默认 `../deepseek-harness`），以及环境变量中的 CLS 凭证与 DeepSeek API Key（`CLS_AGENTOBS_TOPIC_ID`、`TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY`、`DEEPSEEK_API_KEY`；或用 `AGENTOBS_DEV_SECRETS_FILE` 指向仓库外的文件）：

```bash
npm run e2e        # headless：bash + read
npm run e2e:ptc    # headless + PTC + 子 Agent
npm run e2e:sdk    # 通过 TypeScript SDK，两轮对话
```

## 许可证

MIT
