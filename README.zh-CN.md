# dsh-cls-observability

[English](README.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）0.2.x 的插件：把你的 Agent 的运行过程上报到[腾讯云日志服务 CLS 的 Agent 可观测](https://cloud.tencent.com/document/product/614/136743)，让你能逐个查看每次任务、每轮对话、每次模型调用和工具调用，以及它们的 Token 用量、耗时、错误和成本。

- **完整看到每一次任务**：每轮对话是一条 Trace，按“入口 → Agent → 步骤 → 模型调用 / 工具调用”展开，包含输入与答复、工具参数与结果、首字耗时、Token 用量与缓存命中。代码调用的工具（PTC）和子 Agent 挂在发起它们的调用下面；DSH 自己发起的后台模型调用（会话标题、上下文压缩、自动审查）也会记录，Token 与成本统计不漏。
- **不改 DSH，也不改你的代码**：一个文件，通过 DSH 的 patch 机制加载。不管你怎么运行 DSH 都能用：工作站或虚拟机、系统服务、容器或 Kubernetes、你的程序通过 TypeScript SDK 拉起，或编辑器通过 ACP 接入。
- **数据不丢**：每个 Span 发送前先写入本地磁盘；正常退出、崩溃或 `kill -9` 之后，没送达的部分由同一目录上的下一次启动补发。详见 [docs/reliability.zh-CN.md](docs/reliability.zh-CN.md)。
- **不影响 DSH**：插件内部错误不会传给 DSH；发送在后台进行；内存和磁盘占用都有上限；配置只读真实进程环境，克隆来的仓库里的 `.env` 无法开启采集或改写上报地址。
- **内容由你掌控**：默认采集消息与工具内容（截断），离开本机前先对密钥脱敏；也可以关闭内容采集，只上报结构、耗时与用量。

> 状态：0.1.2 预览版，已在 DSH 0.2.2-rc.1 上验证。暂不支持：临时密钥（STS，CLS 上报接口只接受 SecretId / SecretKey）；崩溃后从未续跑的会话，被打断的那一轮缺少顶层 Span。

## 运行要求

- DeepSeek Harness 0.2.x，Node.js ≥ 24.9（与 DSH 要求一致）
- 一个用于 Agent 可观测的 CLS Trace 主题，以及有该主题写入权限（`cls:UploadLog`）的腾讯云密钥
- 运行 DSH 的地方能访问 CLS：公网域名，或在腾讯云同地域内使用内网域名

## 获取插件

从 npm 包（`npm pack dsh-cls-observability`，或 `npm install` 后使用 `node_modules/dsh-cls-observability/dist/dsh-cls-observability.mjs`）或 GitHub Release 获取 `dsh-cls-observability.mjs`，放到运行 DSH 的地方，例如 `/opt/dsh-cls-observability/dsh-cls-observability.mjs`，并用发布的 `.sha256` 校验。

## 启用

1. 让 DSH 用这个 patch 加载插件：

   ```yaml
   - insert:
       - id: cls-agentobs
         name: /opt/dsh-cls-observability/dsh-cls-observability.mjs
   ```

   | 你怎么启动 DSH | patch 放在哪里 |
   |---|---|
   | 每次启动、所有 profile | `$DSH_HOME/cordis.patch.yml` |
   | 单条命令 | 存成文件，用 `dsh --profile <名字> --patch <文件> …` 传入，**放在应用参数之前**：`dsh --profile headless --patch p.yml --json "任务"` 会加载，`dsh --profile headless --json --patch p.yml "任务"` 不会 |
   | 你的程序通过 TypeScript SDK 拉起 | `patches: ['<文件>']`（见下文） |

2. 给 DSH 进程设置环境变量：

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

   会报告配置情况、数据目录是否可写，以及 CLS 是否接受当前的凭证和主题（发送的是空请求，不会向主题写入数据）。全部通过时返回 0。

4. 照常运行 DSH。设置 `CLS_AGENTOBS_DEBUG=true` 可以在 stderr 看到插件日志。

运行中的 `dsh web` 在 `$DSH_HOME/cordis.patch.yml` 被修改后会自动加载插件，但前提是 DSH 启动时这个文件已经存在（DSH 0.2.2 不会感知启动后才新建的文件）。如果希望以后不重启就能启用插件，请预先放一个内容为 `[]` 的空 patch 文件。环境变量的变更仍需重启。

由程序通过 TypeScript SDK 拉起时：

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const harness = new DeepSeekHarness({
  patches: ['/opt/dsh-cls-observability/agentobs.patch.yml'], // 第 1 步的 patch，存成文件
  // SDK 的 env 会整体替换子进程环境，需要保留 process.env。
  env: { ...process.env, CLS_AGENTOBS_ENABLED: 'true', CLS_AGENTOBS_REGION: 'ap-shanghai', CLS_AGENTOBS_TOPIC_ID: '…' },
})
```

## 按你运行 DSH 的方式接入

插件运行在 DSH 进程里，不依赖你怎么部署 DSH。和运行环境有关的只有两件事：

- **配置**要以环境变量的形式传给 DSH 进程（密钥也可以放在文件里，用 `CLS_AGENTOBS_CREDENTIALS_FILE` 指定，文件变化后自动重读，便于轮换）。
- **数据目录**（`$DSH_HOME/agentobs/outbox`，或 `CLS_AGENTOBS_DATA_DIR`）存放还没送达的数据。只要它比 DSH 进程活得久、之后还会有进程在它上面启动，数据就不会丢。如果你的运行环境会和 DSH 一起结束，就在最后一步把剩下的数据发出去（`--flush`）。

| DSH 运行在哪里 | 配置 | 数据目录 | DSH 停止时 |
|---|---|---|---|
| 工作站或虚拟机（`dsh web`、`dsh tui`、编辑器通过 ACP 接入） | Shell 配置，或编辑器给 Agent 设置的环境变量 | 本地磁盘 | 由一个后台进程发完剩余数据；还没发完的下次启动再发 |
| systemd 等进程管理器托管的服务 | `Environment=` / `EnvironmentFile=` | 本地磁盘 | 停止服务时会结束服务的所有进程（systemd 默认如此），后台进程也会被结束：加一行 `ExecStopPost=node <插件文件> --flush`，或等下次启动再发 |
| 你的程序通过 TypeScript SDK 拉起 | 传入的 `env` | 该次拉起的 `DSH_HOME` | 你的程序还在运行，后台进程能把数据发完 |
| 容器（Docker、Compose 等） | 容器环境变量、密钥管理 | 挂载到 `DSH_HOME` 或数据目录的卷 | 容器会随 DSH 一起结束：用包装脚本（[`entrypoint.sh`](examples/container/entrypoint.sh)）或在 DSH 之后运行 `--flush`；留在卷上的数据由下一个容器发送 |
| Kubernetes | 环境变量来自 Secret | 替换的 Pod 会重新挂载的 PVC；一块盘只给一个 Pod（单副本加 `strategy: Recreate`，或 StatefulSet）；不要用 `emptyDir` | 包装脚本或 `--relay` sidecar；Pod 被杀或被驱逐时，下一个 Pod 在约两分钟内接管，在哪个节点都可以 |
| 短时环境（CI 任务、Serverless、临时沙箱） | 任务环境变量、密钥管理 | 随环境一起丢弃 | 最后一步运行 `--flush`；被强制结束时没送达的数据会丢失 |

我们实际验证过的：工作站（Linux、macOS）、SDK、容器、Kubernetes（TKE）。systemd 与短时环境两行基于同样的机制推导，尚未端到端实测。

第一次在 Kubernetes 上部署？[docs/kubernetes.zh-CN.md](docs/kubernetes.zh-CN.md) 从零开始带你走一遍：做镜像、本机试跑、在 TKE 上跑 Job 和网页版 Deployment，最后到 CLS 里找到 Trace。

[`examples/`](examples) 下是示例，请按你的实际部署调整：

- [`container/Dockerfile.snippet`](examples/container/Dockerfile.snippet)：加到你自己的 DSH 镜像里的几行（插件文件按校验值核对、patch 文件、可选的包装脚本），镜像中不含密钥；
- [`container/entrypoint.sh`](examples/container/entrypoint.sh)：运行你的命令，转发 SIGTERM / SIGINT，命令退出后把剩余数据发完；
- [`kubernetes/dsh-agentobs.yaml`](examples/kubernetes/dsh-agentobs.yaml)：一个 Deployment 和一个 Job，插件需要的部分用 `# agentobs` 标出（Secret、内网域名、数据目录放在 PVC、可选的 `--relay` sidecar）。

插件文件自带的命令（读取同样的 `CLS_AGENTOBS_*` 变量）：

| 命令 | 作用 |
|---|---|
| `node dsh-cls-observability.mjs --selftest [目录]` | 检查配置、数据目录以及 CLS 凭证与主题，不写入数据 |
| `node dsh-cls-observability.mjs --flush [目录]` | 把数据目录里剩下的数据补发一次；全部送达时返回 0 |
| `node dsh-cls-observability.mjs --relay [目录]` | 每隔 `CLS_AGENTOBS_RELAY_INTERVAL_MS`（默认 5000）持续补发；收到 SIGTERM 时最后补发一次 |

## 配置

所有变量只从真实进程环境读取。进程环境中设置 `CLS_AGENTOBS_TRUST_USER_ENV=true` 时，也接受 `$DSH_HOME/.env`；项目目录下的 `.env` 始终被忽略。完整列表见 [README.md](README.md#configuration)，常用项：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CLS_AGENTOBS_ENABLED` | – | 设为 `true` 开启 |
| `CLS_AGENTOBS_REGION` / `CLS_AGENTOBS_TOPIC_ID` | – | 地域与 Trace 主题 |
| `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` | – | 密钥；也可用 `CLS_AGENTOBS_CREDENTIALS_FILE` 指定凭证文件（变更后自动重读） |
| `CLS_AGENTOBS_NETWORK` | 公网 | `internal` 使用内网域名（腾讯云同地域内） |
| `CLS_AGENTOBS_ENDPOINT` | – | 改为发往其他 OTLP/HTTP 端点（你自己的 Collector 或转发进程）；明文 http 发往非本机地址时不携带凭证 |
| `CLS_AGENTOBS_CAPTURE_CONTENT` | `truncate` | 消息与工具内容：`truncate`（单字段截断到 `CLS_AGENTOBS_CONTENT_MAX_CHARS`，默认 32000）/ `full` / `off` |
| `CLS_AGENTOBS_JOURNAL` | `true` | 发送前先写磁盘（进程崩溃不丢）；`false` 仅保存在内存 |
| `CLS_AGENTOBS_REDACT` | `on` | 上报前对内容做密钥脱敏（见下文）；`off` 关闭 |
| `CLS_AGENTOBS_REDACT_PATTERNS` | – | 自定义脱敏规则：正则表达式的 JSON 数组，如 `["EMP-\\d{6}"]` |
| `CLS_AGENTOBS_INCLUDE_AUXILIARY` | `true` | 记录 DSH 自己发起的后台模型调用（压缩、会话标题、自动审查），保证 Token 与成本统计完整；设为 `false` 不采集 |
| `CLS_AGENTOBS_SAMPLE_RATIO` | `1` | 按会话采样 |
| `CLS_AGENTOBS_ENVIRONMENT` | – | 标记环境（如 `production`），便于区分 |
| `CLS_AGENTOBS_CUSTOM_ATTRIBUTES` | – | `k=v,k2=v2`，作为 `agent.custom.k` 附在每个 Span 上，便于按团队、应用等筛选 |
| `CLS_AGENTOBS_DATA_DIR` | `$DSH_HOME/agentobs/outbox` | 数据目录；须为绝对路径、属于运行 DSH 的用户（符号链接或他人的目录会被拒绝） |
| `CLS_AGENTOBS_MAX_QUEUE_SPANS` / `CLS_AGENTOBS_MAX_QUEUE_MB` | `20000` / `256` | 内存队列上限（条数 / 估算大小），超出时最旧的 Span 转存到磁盘 |
| `CLS_AGENTOBS_DEBUG` | `false` | stderr 诊断日志 |

`gen_ai.entry.type` 取自 DSH profile：`headless` → `cli`、`web` → `web`、`desktop` → `desktop`、`sdk` / `sdk-minimal` → `sdk`、`acp` → `acp`，自定义 profile 取其名称。profile 名同时记录在 `agent.custom.dsh_profile`。可用 `CLS_AGENTOBS_ENTRY_TYPE` / `CLS_AGENTOBS_ENTRY_PLATFORM` 覆盖。

## 采集内容

| Span | 名称 | 说明 |
|---|---|---|
| entry | `enter_application` | 每个 turn 一个；包含本轮输入与最终答复；`agent.custom.trigger` 区分用户发起与自动续跑 |
| agent | `invoke_agent <名字>` | `main`，或子 Agent 的名字；子 Agent 带 `gen_ai.operation.name=invoke_subagent` 与 `gen_ai.agent.scope=subagent`。在父 Trace 内运行的子 Agent 轮次没有 entry，agent 直接挂在启动它的工具调用下 |
| step | `react round_<N>` | 每次模型 step 一个 |
| chat | `chat <模型>` | 用量（含缓存命中、推理 token）、首 token 耗时、结束原因、请求参数。输入在会话首次调用时为全量上下文，之后只上报新增部分（`gen_ai.input.messages_delta`，从完整输入的第 `agent.custom.input_delta_start` 条开始，共 `agent.custom.input_message_count` 条，序号从 0 起）；`gen_ai.input.messages.hash` 对应完整上下文 |
| tool | `execute_tool <工具名>` | 入参、结果、错误；耗时不含人工审批等待；PTC 内层调用挂在 `run_code` 下 |

你的 DSH 配置允许几层子 Agent，就记录几层。子 Agent 上报发起任务的那个会话的 `gen_ai.session.id`，会话分析与成本因此覆盖整个任务；它的轮次 ID 带有自己的一段（`<任务会话>:<子Agent>:t<N>`），自己的 DSH 会话 ID 保留在 `gen_ai.agent.id`。DSH 0.2.2-rc.1 不记录子 Agent 的名字，只有模型派发任务时写的描述：开启内容采集时，用这段描述（脱敏后，最长 80 字）作为 Agent 名；关闭内容采集时，名字为 `subagent`。之后的 DSH 版本会记录 `agent-1` 这样的名字，按原样使用。

Trace 与 Span ID 由会话内容计算得出，同一个 Span 无论发送几次 ID 都相同。投递语义为至少一次：只有在请求已成功、但进程在收到响应前退出时才会产生重复。

### 内容与隐私

默认采集消息与工具内容（截断模式），这样你能看到每次模型调用的输入输出、每次工具调用的参数和结果。这些内容可能包含用户与工具交换的任何数据。设置 `CLS_AGENTOBS_CAPTURE_CONTENT=off` 后只上报结构、耗时与用量。

内容离开进程前会先脱敏，命中处替换为 `[REDACTED:<规则名>]`，Span 上标注 `agent.custom.content_redacted`，命中的规则记录在 `agent.custom.redacted_types`：

- **本机持有的密钥**：无论以什么形式出现（`printenv` 输出、引号里的值、一段文字），都会被打码。包括插件正在使用的 CLS 密钥，以及 DSH 进程环境里所有名字像凭证的变量（`*_SECRET*`、`*_TOKEN`、`*_API_KEY`、`*PASSWORD*` 等；路径、URL、普通单词会跳过）。没有前缀、只是一串随机字符的云厂商 SecretKey，靠的就是这一层；
- 有固定前缀的格式：私钥、腾讯云 SecretId（`AKID…`）、AWS（`AKIA…`）、阿里云（`LTAI…`）、火山引擎（`AKLT…`）、Azure 连接串中的密钥、GitHub / GitLab / Slack / Hugging Face Token、Google API Key、`sk-…` / `sk_live_…` 形式的 API Key、JWT、`Bearer` / `Basic` 凭证、URL 中的密码；
- 凭证类键名后面的值：`KEY=value`、`"key": "value"`、`--secret-key value`、`密码是 value`、`SecretKey：value`，以及工具入参中这类键下的值。代码写法不会被打码，如 `token = getToken()`、`password: $DB_PASS`、`apiKey: string`、`token = requestToken`。

识别不了的情况：不在本机环境里、没有前缀的第三方密钥（例如 AWS Secret Key、其他账号的 SecretKey）单独出现，旁边也没有键名。这种字符串和哈希值、ID 无法区分。可用 `CLS_AGENTOBS_REDACT_PATTERNS` 补充自己的格式，或关闭内容采集。

另见 [SECURITY.md](SECURITY.md)。

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
