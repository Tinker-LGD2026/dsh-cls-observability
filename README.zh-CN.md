# dsh-cls-observability

[English](README.md)

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）0.2.x 的 Agent 运行过程，以 OpenTelemetry Trace 的形式上报到[腾讯云日志服务 CLS AgentObs](https://cloud.tencent.com/document/product/614/136743)。

- **单文件、零依赖**：`dist/dsh-cls-observability.mjs` 是一个 Cordis 插件，在 DSH 任意 patch 层按文件路径加载即可。不需要 `dsh plugin add`，不需要每个 profile 单独安装，Agent 主机上也不需要包管理器。
- **AgentObs 语义**：每个 turn 五层 Span（`entry → agent → step → chat / tool`），字段按 CLS 定义；包含 token 用量、首 token 耗时、工具入参与结果、PTC（`run_code`）内层工具调用、挂在父工具调用下的子 Agent、辅助模型调用（压缩、会话标题、自动审查）、审批与重试。
- **不丢数据**：每个 Span 发送前先写入本地磁盘日志，进程被直接杀掉（`kill -9`、OOM）也不丢，下次启动补发未确认的部分；正常退出时未发送的 Span 写入本地 outbox，由独立进程补发；CLS 长时间不可达时多出的 Span 转存磁盘而不是丢弃；崩溃时进行中的 turn 会在 DSH 续跑该会话时补上根 Span。
- **不影响宿主**：插件异常不会传给 DSH；不参与 DSH 的会话检查点；配置只读真实进程环境，克隆来的仓库里的 `.env` 无法开启采集、改写上报地址或修改内容采集设置。

> 状态：0.1.0 预览版。不支持：临时密钥（STS，CLS AgentObs 上报接口文档只提供 SecretId / SecretKey）；崩溃后从未续跑的会话中未结束的 turn。

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

3. 不发送任何 Trace 数据即可检查配置：

   ```bash
   node /opt/dsh-cls-observability/dsh-cls-observability.mjs --selftest
   ```

   会报告配置情况、outbox 是否可写，以及 CLS 是否接受当前的凭证和主题（发送的是空请求，不会向主题写入数据）。全部通过时返回 0。

4. 照常运行 DSH（`dsh web`、`dsh headless "…"` 等）。设置 `CLS_AGENTOBS_DEBUG=true` 可以在 stderr 看到插件日志。

运行中的 `dsh web` 在 `$DSH_HOME/cordis.patch.yml` 被修改后会自动加载插件，但前提是 DSH 启动时这个文件已经存在（DSH 0.2.2 不会感知启动后才新建的文件）。如果希望以后不重启就能启用插件，请预先放一个内容为 `[]` 的空 patch 文件。环境变量的变更仍需重启。

### 由程序拉起（TypeScript SDK）

把第 1 步的 patch 内容单独存成一个文件，例如 `/opt/dsh-cls-observability/agentobs.patch.yml`，在每次拉起时传入（用 home patch 也可以）：

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const harness = new DeepSeekHarness({
  patches: ['/opt/dsh-cls-observability/agentobs.patch.yml'],
  // SDK 的 env 会整体替换子进程环境，需要保留 process.env。
  env: { ...process.env, CLS_AGENTOBS_ENABLED: 'true', CLS_AGENTOBS_REGION: 'ap-shanghai', CLS_AGENTOBS_TOPIC_ID: '…' },
})
```

### 注意事项

- **`--patch` 要放在应用参数之前。** `dsh` 启动器从第一个它不认识的参数开始，后面的全部交给 profile：`dsh --profile headless --patch p.yml --json "任务"` 会加载插件，`dsh --profile headless --json --patch p.yml "任务"` 不会。
- **子 Agent 嵌套。** DSH 默认只允许 1 层委派。要让子 Agent 再派子 Agent，在 patch 里调高：`- id: subagent` / `config: { maxDepth: 2 }`。每一层都归到发起任务的那个会话里。
- **子 Agent 的名字。** DSH 0.2.2-rc.1 不记录子 Agent 的名字，只有模型派发任务时写的描述。开启内容采集时，用这段描述（脱敏后，最长 80 字）作为 Agent 名；关闭内容采集时，名字为 `subagent`。之后的 DSH 版本会记录 `agent-1` 这样的名字，按原样使用。

## 容器部署

容器的主进程一退出，容器就会停止，插件的独立补发进程也会被一起杀掉。[`deploy/`](deploy) 下提供了模板：

- [`entrypoint.sh`](deploy/entrypoint.sh)：启动 DSH 并转发 SIGTERM / SIGINT，DSH 退出后先补发剩余数据（`node dsh-cls-observability.mjs --flush`），再退出容器；
- [`Dockerfile.snippet`](deploy/Dockerfile.snippet)：在已有 DSH 的镜像中加入插件（校验 SHA-256）、入口脚本和 patch 文件，镜像中不含凭证；
- [`k8s/deployment.yaml`](deploy/k8s/deployment.yaml)：凭证来自 Secret、使用 CLS 内网域名、`DSH_HOME` 放在 PVC 上（崩溃或被驱逐的 Pod 留下的数据由下一个 Pod 补发）、优雅退出时间覆盖补发耗时，并附可选的原生 sidecar（`--relay`）。

插件文件自带的命令（读取同样的 `CLS_AGENTOBS_*` 变量）：

| 命令 | 作用 |
|---|---|
| `node dsh-cls-observability.mjs --selftest [目录]` | 检查配置、outbox 以及 CLS 凭证与主题，不写入数据 |
| `node dsh-cls-observability.mjs --flush [目录]` | 补发一次 outbox 及已退出进程的写前日志；全部送达时返回 0 |
| `node dsh-cls-observability.mjs --relay [目录]` | 每隔 `CLS_AGENTOBS_RELAY_INTERVAL_MS`（默认 5000）持续补发；收到 SIGTERM 时最后补发一次 |

默认目录为 `$DSH_HOME/agentobs/outbox`（或 `CLS_AGENTOBS_DATA_DIR`）。

如需不重启 DSH 轮换密钥，可让 `CLS_AGENTOBS_CREDENTIALS_FILE` 指向由密钥管理工具更新的文件，文件变化后插件会自动重读。

## 配置

所有变量只从真实进程环境读取。进程环境中设置 `CLS_AGENTOBS_TRUST_USER_ENV=true` 时，也接受 `$DSH_HOME/.env`；项目目录下的 `.env` 始终被忽略。完整列表见 [README.md](README.md#configuration)，常用项：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CLS_AGENTOBS_ENABLED` | – | 设为 `true` 开启 |
| `CLS_AGENTOBS_REGION` / `CLS_AGENTOBS_TOPIC_ID` | – | 地域与 Trace 主题 |
| `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` | – | 密钥；也可用 `CLS_AGENTOBS_CREDENTIALS_FILE` 指定凭证文件（变更后自动重读） |
| `CLS_AGENTOBS_NETWORK` | 公网 | `internal` 使用内网域名 |
| `CLS_AGENTOBS_ENDPOINT` | – | 改为发往其他 OTLP/HTTP 端点（Collector、转发进程）；明文 http 发往非本机地址时不携带凭证 |
| `CLS_AGENTOBS_CAPTURE_CONTENT` | `truncate` | 消息与工具内容：`truncate`（单字段截断到 `CLS_AGENTOBS_CONTENT_MAX_CHARS`，默认 32000）/ `full` / `off` |
| `CLS_AGENTOBS_JOURNAL` | `true` | 发送前先写磁盘日志（进程崩溃不丢）；`false` 仅保存在内存 |
| `CLS_AGENTOBS_REDACT` | `on` | 上报前对内容做密钥脱敏（见下文）；`off` 关闭 |
| `CLS_AGENTOBS_REDACT_PATTERNS` | – | 自定义脱敏规则：正则表达式的 JSON 数组，如 `["EMP-\\d{6}"]` |
| `CLS_AGENTOBS_INCLUDE_AUXILIARY` | `true` | 记录压缩、会话标题等辅助模型调用，保证 Token 与成本统计完整；设为 `false` 不采集 |
| `CLS_AGENTOBS_SAMPLE_RATIO` | `1` | 按会话采样 |
| `CLS_AGENTOBS_CUSTOM_ATTRIBUTES` | – | `k=v,k2=v2`，作为 `agent.custom.k` 附在每个 Span 上 |
| `CLS_AGENTOBS_DATA_DIR` | `$DSH_HOME/agentobs/outbox` | outbox 目录；须为绝对路径、属于运行 DSH 的用户（符号链接或他人的目录会被拒绝） |
| `CLS_AGENTOBS_MAX_QUEUE_SPANS` / `CLS_AGENTOBS_MAX_QUEUE_MB` | `20000` / `256` | 内存队列上限（条数 / 估算大小），超出时最旧的 Span 转存到 outbox |
| `CLS_AGENTOBS_DEBUG` | `false` | stderr 诊断日志 |

`gen_ai.entry.type` 取自 DSH profile：`headless` → `cli`、`web` → `web`、`desktop` → `desktop`、`sdk` / `sdk-minimal` → `sdk`、`acp` → `acp`，自定义 profile 取其名称。profile 名同时记录在 `agent.custom.dsh_profile`。可用 `CLS_AGENTOBS_ENTRY_TYPE` / `CLS_AGENTOBS_ENTRY_PLATFORM` 覆盖。

## 采集内容

| Span | 名称 | 说明 |
|---|---|---|
| entry | `enter_application` | 每个 turn 一个；包含本轮输入与最终答复；`agent.custom.trigger` 区分用户发起与自动续跑 |
| agent | `invoke_agent <名字>` | `main`，或子 Agent 的名字（见“注意事项”）；子 Agent 带 `gen_ai.operation.name=invoke_subagent` 与 `gen_ai.agent.scope=subagent`。在父 Trace 内运行的子 Agent 轮次没有 entry，agent 直接挂在启动它的工具调用下 |
| step | `react round_<N>` | 每次模型 step 一个 |
| chat | `chat <模型>` | 用量（含缓存命中、推理 token）、首 token 耗时、结束原因、请求参数。输入在会话首次调用时为全量上下文，之后只上报新增部分（`gen_ai.input.messages_delta`）；`gen_ai.input.messages.hash` 对应完整上下文 |
| tool | `execute_tool <工具名>` | 入参、结果、错误；耗时不含人工审批等待；PTC 内层调用挂在 `run_code` 下 |

子 Agent 上报发起任务的那个会话的 `gen_ai.session.id`，会话分析与成本因此覆盖整个任务；它的轮次 ID 带有自己的一段（`<任务会话>:<子Agent>:t<N>`），自己的 DSH 会话 ID 保留在 `gen_ai.agent.id`。

Trace 与 Span ID 由会话日志计算得出，同一个 Span 无论发送几次 ID 都相同。投递语义为至少一次：只有在请求已成功、但进程在收到响应前退出时才会产生重复。

### 内容与隐私

默认采集消息与工具内容（截断模式），因为 CLS AgentObs 控制台需要展示 chat 输入输出和工具入参结果。这些内容可能包含用户与工具交换的任何数据。设置 `CLS_AGENTOBS_CAPTURE_CONTENT=off` 后只上报结构、耗时与用量。

内容离开进程前会先脱敏，命中处替换为 `[REDACTED:<规则名>]`，Span 上标注 `agent.custom.content_redacted`，命中的规则记录在 `agent.custom.redacted_types`：

- **本机持有的密钥**：无论以什么形式出现（`printenv` 输出、引号里的值、一段文字），都会被打码。包括插件正在使用的 CLS 密钥，以及 DSH 进程环境里所有名字像凭证的变量（`*_SECRET*`、`*_TOKEN`、`*_API_KEY`、`*PASSWORD*` 等；路径、URL、普通单词会跳过）。没有前缀、只是一串随机字符的云厂商 SecretKey，靠的就是这一层；
- 有固定前缀的格式：私钥、腾讯云 SecretId（`AKID…`）、AWS（`AKIA…`）、阿里云（`LTAI…`）、火山引擎（`AKLT…`）、Azure 连接串中的密钥、GitHub / GitLab / Slack / Hugging Face Token、Google API Key、`sk-…` / `sk_live_…` 形式的 API Key、JWT、`Bearer` / `Basic` 凭证、URL 中的密码；
- 凭证类键名后面的值：`KEY=value`、`"key": "value"`、`--secret-key value`、`密码是 value`、`SecretKey：value`，以及工具入参中这类键下的值。代码写法不会被打码，如 `token = getToken()`、`password: $DB_PASS`、`apiKey: string`、`token = requestToken`。

识别不了的情况：不在本机环境里、没有前缀的第三方密钥（例如 AWS Secret Key、其他账号的 SecretKey）单独出现，旁边也没有键名。这种字符串和哈希值、ID 无法区分。可用 `CLS_AGENTOBS_REDACT_PATTERNS` 补充自己的格式，或关闭内容采集。

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
