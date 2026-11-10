# dsh-cls-observability

[中文](README.zh-CN.md)

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 0.2.x that sends what your agents
do to [Tencent Cloud CLS Agent Observability](https://cloud.tencent.com/document/product/614/136743), where you can
follow every task, turn, model call and tool call with its token usage, latency, errors and cost.

- **See every task end to end.** Each turn becomes a trace — entry → agent → step → model calls and tool calls — with
  prompts and answers, tool arguments and results, time to first token, token usage and cache hits. Code-driven tool
  calls (PTC) and subagents appear under the call that started them, and DSH's own background model calls (session
  title, compaction, auto review) are included, so token and cost totals are complete.
- **No change to DSH or to your code.** One file, loaded through DSH's patch mechanism. It works however you run DSH:
  on a workstation or VM, as a service, in containers or Kubernetes, from your own program through the TypeScript SDK,
  or from an editor over ACP.
- **Spans are not lost.** Each span is written to local disk before it is sent; after a normal exit, a crash or a
  `kill -9`, what was not delivered is sent by the next start on the same directory. See
  [docs/reliability.md](docs/reliability.md).
- **Safe for DSH.** Plugin errors never reach DSH, sending happens in the background, memory and disk use are bounded,
  and configuration comes only from the real process environment (a cloned repository's `.env` cannot enable it or
  redirect it).
- **You control the content.** Message and tool content is captured (truncated) and secrets are masked before it leaves
  the machine; switch content off to send structure, timing and usage only.

> Status: 0.1.0 preview, verified with DSH 0.2.2-rc.1. Not supported yet: temporary (STS) credentials (the CLS
> endpoint accepts SecretId / SecretKey only); turns of a crashed session that is never resumed stay without their
> top-level spans.

## Requirements

- DeepSeek Harness 0.2.x, Node.js ≥ 24.9 (DSH's own requirement)
- A CLS trace topic for Agent Observability, and a Tencent Cloud key allowed to write to it (`cls:UploadLog`)
- Network access from where DSH runs to CLS: the public endpoint, or the intranet endpoint from Tencent Cloud in the
  same region

## Install

Get `dsh-cls-observability.mjs` from the npm package (`npm pack dsh-cls-observability`, or `npm install` it and use
`node_modules/dsh-cls-observability/dist/dsh-cls-observability.mjs`) or from a GitHub release, and put it where DSH
runs, e.g. `/opt/dsh-cls-observability/dsh-cls-observability.mjs`. Check it against the published `.sha256`.

## Enable

1. Have DSH load the plugin with this patch:

   ```yaml
   - insert:
       - id: cls-agentobs
         name: /opt/dsh-cls-observability/dsh-cls-observability.mjs
   ```

   | How you start DSH | Where the patch goes |
   |---|---|
   | Every start, every profile | `$DSH_HOME/cordis.patch.yml` |
   | One command line | A file passed with `dsh --profile <name> --patch <file> …` — **before** the app's own arguments: `dsh --profile headless --patch p.yml --json "task"` loads it, `dsh --profile headless --json --patch p.yml "task"` does not |
   | Your program, through the TypeScript SDK | `patches: ['<file>']` (see below) |

2. Give the DSH process its configuration:

   ```bash
   export CLS_AGENTOBS_ENABLED=true
   export CLS_AGENTOBS_REGION=ap-shanghai
   export CLS_AGENTOBS_TOPIC_ID=<your trace topic id>
   export TENCENTCLOUD_SECRET_ID=<secret id>
   export TENCENTCLOUD_SECRET_KEY=<secret key>
   ```

3. Check the setup without sending any trace data:

   ```bash
   node /opt/dsh-cls-observability/dsh-cls-observability.mjs --selftest
   ```

   It reports the configuration, whether the data directory is writable, and whether CLS accepts the credentials and
   topic (an empty request: nothing is written to the topic). Exit code 0 when everything passes.

4. Run DSH as usual. Set `CLS_AGENTOBS_DEBUG=true` to see what the plugin does on stderr.

A running `dsh web` picks up the plugin when you edit `$DSH_HOME/cordis.patch.yml` — provided that file already existed
when DSH started (DSH 0.2.2 does not notice the file being created later). To enable the plugin later without a
restart, keep an empty `[]` patch file in place. Changing the environment variables still needs a restart.

From a program, through the TypeScript SDK:

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const harness = new DeepSeekHarness({
  patches: ['/opt/dsh-cls-observability/agentobs.patch.yml'], // the patch of step 1, in a file
  // The SDK's `env` replaces the child environment entirely: keep process.env.
  env: { ...process.env, CLS_AGENTOBS_ENABLED: 'true', CLS_AGENTOBS_REGION: 'ap-shanghai', CLS_AGENTOBS_TOPIC_ID: '…' },
})
```

## Fitting it into how you run DSH

The plugin runs inside the DSH process and does not depend on how you deploy DSH. Two things depend on your
environment:

- **Configuration** has to reach the DSH process as environment variables (credentials may also come from a file,
  `CLS_AGENTOBS_CREDENTIALS_FILE`, re-read when it changes — handy for rotation).
- **The data directory** — `$DSH_HOME/agentobs/outbox`, or `CLS_AGENTOBS_DATA_DIR` — holds what has not been sent yet.
  If it outlives the DSH process and something starts on it again, nothing is lost. If your environment ends together
  with DSH, deliver what is left as its last step (`--flush`).

| Where DSH runs | Configuration | Data directory | When DSH stops |
|---|---|---|---|
| Workstation or VM (`dsh web`, `dsh tui`, an editor over ACP) | Shell profile, or the editor's environment for the agent | Local disk | A background process sends what is left; anything still pending goes at the next start |
| A service under systemd or another supervisor | `Environment=` / `EnvironmentFile=` | Local disk | A supervisor that stops every process of the service (systemd's default) stops that background process too: add `ExecStopPost=node <plugin> --flush`, or let the next start send it |
| Your program, through the TypeScript SDK | The `env` you pass | The launch's `DSH_HOME` | Your program keeps running, so the background process finishes |
| Containers (Docker, Compose, …) | Container environment, secrets | A volume at `DSH_HOME` or the data directory | The container ends with DSH: wrap the command ([`entrypoint.sh`](examples/container/entrypoint.sh)) or run `--flush` after DSH; what remains on the volume goes with the next container |
| Kubernetes | Environment from a Secret | A PersistentVolumeClaim that replacement pods mount again; one pod per volume (one replica with `strategy: Recreate`, or a StatefulSet); not `emptyDir` | Wrapper or `--relay` sidecar; data of a killed or evicted pod is taken over by the next pod, on any node, within about two minutes |
| Short-lived environments (CI jobs, serverless, throwaway sandboxes) | Job environment, secrets | Discarded with the environment | Run `--flush` as the last step; a hard kill loses what was not sent |

Verified by us: workstation (Linux, macOS), SDK, containers, Kubernetes (TKE). The systemd and short-lived rows follow
from the same mechanism but were not run end to end.

Examples in [`examples/`](examples) — adapt them to your own setup:

- [`container/Dockerfile.snippet`](examples/container/Dockerfile.snippet): lines to add to your DSH image (plugin file
  verified against its checksum, the patch, the optional wrapper); no credentials in the image;
- [`container/entrypoint.sh`](examples/container/entrypoint.sh): runs your command, forwards SIGTERM / SIGINT, and
  delivers what is left after it exits;
- [`kubernetes/dsh-agentobs.yaml`](examples/kubernetes/dsh-agentobs.yaml): a Deployment and a Job with the plugin's
  parts marked `# agentobs` (Secret, intranet endpoint, data directory on a PVC, optional `--relay` sidecar).

Commands of the plugin file (they read the same `CLS_AGENTOBS_*` variables):

| Command | Does |
|---|---|
| `node dsh-cls-observability.mjs --selftest [dir]` | Check configuration, data directory and CLS credentials / topic without writing data |
| `node dsh-cls-observability.mjs --flush [dir]` | Deliver everything left in the data directory once; exit 0 when empty |
| `node dsh-cls-observability.mjs --relay [dir]` | Keep delivering every `CLS_AGENTOBS_RELAY_INTERVAL_MS` (5000); final flush on SIGTERM |

## Configuration

All variables are read from the real process environment only. `$DSH_HOME/.env` is also accepted when
`CLS_AGENTOBS_TRUST_USER_ENV=true` is set in the process environment; a project `.env` is always ignored.

| Variable | Default | Meaning |
|---|---|---|
| `CLS_AGENTOBS_ENABLED` | – | `true` to enable |
| `CLS_AGENTOBS_REGION` | – | CLS region, e.g. `ap-shanghai` (builds the endpoint) |
| `CLS_AGENTOBS_TOPIC_ID` | – | Trace topic |
| `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` | – | Credentials |
| `CLS_AGENTOBS_CREDENTIALS_FILE` | – | Instead of the two above: JSON `{secretId, secretKey}` or `KEY=value` lines; re-read when it changes |
| `CLS_AGENTOBS_NETWORK` | public | `internal` uses the intranet endpoint (from Tencent Cloud, same region) |
| `CLS_AGENTOBS_ENDPOINT` | – | Send to another OTLP/HTTP endpoint instead (your collector or relay); https, or http on loopback / with `CLS_AGENTOBS_ALLOW_HTTP=true` (credentials are never sent over http to another host) |
| `CLS_AGENTOBS_CAPTURE_CONTENT` | `truncate` | Message and tool content: `truncate` / `full` / `off` (also `true` / `false`); `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` is honoured too |
| `CLS_AGENTOBS_CONTENT_MAX_CHARS` | `32000` | Per-field limit in `truncate` mode |
| `CLS_AGENTOBS_REDACT` | `on` | Mask secrets in captured content (see below); `off` to disable |
| `CLS_AGENTOBS_REDACT_PATTERNS` | – | Extra patterns: JSON array of regular expressions, e.g. `["EMP-\\d{6}"]` |
| `CLS_AGENTOBS_INCLUDE_AUXILIARY` | `true` | Record DSH's background model calls (compaction, title, auto review) so token totals and cost are complete; `false` to skip them |
| `CLS_AGENTOBS_SAMPLE_RATIO` | `1` | Per-session sampling |
| `CLS_AGENTOBS_SERVICE_NAME` | `deepseek-harness` | `service.name` |
| `CLS_AGENTOBS_ENVIRONMENT` | – | `deployment.environment.name`, to tell environments apart |
| `CLS_AGENTOBS_ENTRY_TYPE` / `_ENTRY_PLATFORM` | from profile | Override `gen_ai.entry.type` / `gen_ai.entry.platform` |
| `CLS_AGENTOBS_USER_ID` / `_USER_NAME` | – | `gen_ai.user.id` / `gen_ai.user.name` |
| `CLS_AGENTOBS_CUSTOM_ATTRIBUTES` | – | `k=v,k2=v2` → `agent.custom.k` on every span, to filter by team, app, … (secret-like keys are dropped) |
| `CLS_AGENTOBS_DATA_DIR` | `$DSH_HOME/agentobs/outbox` | Data directory; absolute path, owned by the user running DSH (a symlink or someone else's directory is refused) |
| `CLS_AGENTOBS_DETACHED_DELIVERY` | `true` | Deliver what is left at exit from a background process |
| `CLS_AGENTOBS_JOURNAL` | `true` | Write spans to disk before sending (survives a crash); `false` keeps them in memory only |
| `CLS_AGENTOBS_EXPORT_TIMEOUT_MS` | `15000` | Per request |
| `CLS_AGENTOBS_SHUTDOWN_TIMEOUT_MS` | `3500` | In-process delivery budget at exit (DSH force-exits after 5 s) |
| `CLS_AGENTOBS_MAX_QUEUE_SPANS` | `20000` | In-memory queue bound (spans) |
| `CLS_AGENTOBS_MAX_QUEUE_MB` | `256` | In-memory queue bound (estimated size); beyond either bound the oldest spans move to disk |
| `CLS_AGENTOBS_DEBUG` | `false` | Diagnostics on stderr |

`gen_ai.entry.type` follows the DSH profile: `headless` → `cli`, `web` → `web`, `desktop` → `desktop`,
`sdk` / `sdk-minimal` → `sdk`, `acp` → `acp`, a custom profile → its name. The profile name itself is also recorded as
`agent.custom.dsh_profile`.

## What is recorded

| Span | Name | Notes |
|---|---|---|
| entry | `enter_application` | One per turn; the turn's prompt and final answer; `agent.custom.trigger` tells user prompts from automatic continuations |
| agent | `invoke_agent <name>` | `main`, or the subagent's name; subagents have `gen_ai.operation.name=invoke_subagent` and `gen_ai.agent.scope=subagent`. A subagent turn running inside its parent's trace has no entry: its agent span hangs off the tool call that started it |
| step | `react round_<N>` | One per model step |
| chat | `chat <model>` | Usage (cache read/miss, reasoning), time to first token, finish reason, request parameters. Input is the full context on a session's first call, then only what each call added (`gen_ai.input.messages_delta`, starting at message `agent.custom.input_delta_start` of `agent.custom.input_message_count`); `gen_ai.input.messages.hash` covers the full context |
| tool | `execute_tool <name>` | Arguments, result, error; execution time excludes human approval waits; PTC inner calls nest under `run_code` |

Subagents are recorded at every nesting depth your DSH configuration allows. A subagent reports the `gen_ai.session.id`
of the task that started it, so session analysis and cost cover the whole task; its turns get their own segment
(`<task>:<child>:t<N>`) and its own DSH session id stays in `gen_ai.agent.id`. DSH 0.2.2-rc.1 records no subagent names,
only the task description the model gave it: that description becomes the agent name (redacted, at most 80
characters) when content capture is on, and the name is `subagent` when it is off. Later DSH versions record names such
as `agent-1`, used as they are.

Trace and span ids are derived from the session, so a span is identified the same way however often it is sent.
Delivery is at least once; a duplicate can only occur when a request succeeded but the process died before its
response arrived.

### Content and privacy

Message and tool content is captured by default (truncated), so that you can read each model call's input and output
and each tool's arguments and result. It can contain anything users and tools exchange. Set
`CLS_AGENTOBS_CAPTURE_CONTENT=off` to send structure, timing and usage only.

Before content leaves the process, secrets are masked as `[REDACTED:<rule>]` (the span is marked
`agent.custom.content_redacted` with the rule names in `agent.custom.redacted_types`):

- **secrets the machine holds**, wherever and however they appear (`printenv` output, a quoted value, prose): the CLS
  key in use and every credential-named environment variable of the DSH process (`*_SECRET*`, `*_TOKEN`, `*_API_KEY`,
  `*PASSWORD*`, …; paths, URLs and plain words are skipped). This is what catches a bare cloud SecretKey, which is just
  random characters;
- formats with a recognisable prefix: private keys, Tencent Cloud SecretId (`AKID…`), AWS (`AKIA…`), Alibaba Cloud
  (`LTAI…`), Volcengine (`AKLT…`), Azure connection-string keys, GitHub / GitLab / Slack / Hugging Face tokens, Google
  API keys, `sk-…` / `sk_live_…` API keys, JWTs, `Bearer` / `Basic` credentials, passwords in URLs;
- the value after a credential-named key: `KEY=value`, `"key": "value"`, `--secret-key value`, `密码是 value`,
  `SecretKey：value`, and values under such keys in tool arguments. Code is left alone (`token = getToken()`,
  `password: $DB_PASS`, `apiKey: string`, `token = requestToken`).

What it cannot catch: a third-party secret without a prefix (an AWS secret key, another account's SecretKey) that
appears on its own, with no key name next to it and is not in the machine's environment — it is indistinguishable from
a hash or an id. Add your own formats with `CLS_AGENTOBS_REDACT_PATTERNS`, or turn content capture off.

See also [SECURITY.md](SECURITY.md).

## Develop

```bash
npm install
npm test          # unit tests + replay of every DSH session recording (needs a DSH checkout, see DSH_REPO)
npm run build     # dist/dsh-cls-observability.mjs + .sha256
```

End-to-end scripts run a real DSH task against a CLS topic and read the spans back. They need a DSH source checkout
(`DSH_REPO`, default `../deepseek-harness`), CLS credentials and a DeepSeek API key in the environment
(`CLS_AGENTOBS_TOPIC_ID`, `TENCENTCLOUD_SECRET_ID`, `TENCENTCLOUD_SECRET_KEY`, `DEEPSEEK_API_KEY`; or a file outside
the repository via `AGENTOBS_DEV_SECRETS_FILE`):

```bash
npm run e2e        # headless: bash + read
npm run e2e:ptc    # headless with PTC and a subagent
npm run e2e:sdk    # through the TypeScript SDK, two turns
```

## License

MIT
