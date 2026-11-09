# dsh-cls-observability

[中文](README.zh-CN.md)

Trace collector for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 0.2.x that exports
agent runs to [Tencent Cloud CLS AgentObs](https://cloud.tencent.com/document/product/614/136743) as OpenTelemetry traces.

- **One file, zero dependencies.** `dist/dsh-cls-observability.mjs` is a Cordis plugin loaded by path from any DSH
  patch layer. No `dsh plugin add`, no per-profile install, no package manager on the agent host.
- **AgentObs semantics.** Five span levels per turn — `entry → agent → step → chat / tool` — with the CLS field set,
  token usage, time to first token, tool arguments and results, PTC (`run_code`) nested tool calls, subagents nested
  under the tool call that spawned them, auxiliary model calls (compaction, session title, auto review), approvals,
  retries.
- **Does not lose spans.** Every span is journaled to local disk before it is sent, so a host killed outright
  (`kill -9`, OOM) loses nothing: the next start resends what was not acknowledged. At a normal exit unsent spans go to
  a local outbox and a detached process delivers them. When CLS is unreachable for long, spans overflow to disk instead
  of being dropped. A turn interrupted by a crash gets its root spans when DSH resumes the session.
- **Safe for the host.** Never blocks or fails DSH: every listener is isolated, it does not take part in DSH's session
  checkpoint, and configuration comes only from the real process environment (a cloned repository's `.env` cannot
  enable it, redirect it, or change content capture).

> Status: 0.1.0 preview. Not covered: temporary (STS) credentials (the CLS AgentObs endpoint documents SecretId /
> SecretKey only), turns of a crashed session that is never resumed.

## Requirements

- DeepSeek Harness 0.2.x
- Node.js ≥ 24.9 (DSH's own requirement)
- A CLS AgentObs trace topic, and a Tencent Cloud key allowed to write to it

## Install

Get `dsh-cls-observability.mjs` from the npm package (`npm pack dsh-cls-observability`, or `npm install` it and use
`node_modules/dsh-cls-observability/dist/dsh-cls-observability.mjs`) or from a GitHub release, and put it on the agent
host, e.g. `/opt/dsh-cls-observability/dsh-cls-observability.mjs`. Check it against the published `.sha256`.

## Enable

1. Load the plugin. For every profile, add it to `$DSH_HOME/cordis.patch.yml` (or pass a file with `--patch`):

   ```yaml
   - insert:
       - id: cls-agentobs
         name: /opt/dsh-cls-observability/dsh-cls-observability.mjs
   ```

2. Set the environment of the DSH process:

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

   It reports the configuration, whether the outbox is writable, and whether CLS accepts the credentials and topic
   (an empty request: nothing is written to the topic). Exit code 0 when everything passes.

4. Run DSH as usual (`dsh web`, `dsh headless "…"`, …). Set `CLS_AGENTOBS_DEBUG=true` to see what the plugin does on
   stderr.

A running `dsh web` picks up the plugin when you edit `$DSH_HOME/cordis.patch.yml` — provided that file already existed
when DSH started (DSH 0.2.2 does not notice the file being created later). To enable the plugin without a restart
later on, keep an empty `[]` patch file in place. Changing the environment variables still needs a restart.

### Launched from a program (TypeScript SDK)

Put the patch of step 1 in a file of its own, e.g. `/opt/dsh-cls-observability/agentobs.patch.yml`, and pass it per
launch (the home patch works too):

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const harness = new DeepSeekHarness({
  patches: ['/opt/dsh-cls-observability/agentobs.patch.yml'],
  // The SDK's `env` replaces the child environment entirely: keep process.env.
  env: { ...process.env, CLS_AGENTOBS_ENABLED: 'true', CLS_AGENTOBS_REGION: 'ap-shanghai', CLS_AGENTOBS_TOPIC_ID: '…' },
})
```

### Good to know

- **`--patch` goes before the app's own arguments.** The `dsh` launcher passes everything from the first argument it
  does not know to the profile: `dsh --profile headless --patch p.yml --json "task"` loads the plugin,
  `dsh --profile headless --json --patch p.yml "task"` does not.
- **Nested subagents.** DSH allows one delegation level by default. To let subagents delegate, raise it in a patch:
  `- id: subagent` / `config: { maxDepth: 2 }`. Every level is reported in the session of the task that started it.
- **Subagent names.** DSH 0.2.2-rc.1 records no name for a subagent, only the task description the model gave it; that
  description becomes the agent name (redacted, at most 80 characters) when content capture is on, and the name is
  `subagent` when it is off. Later DSH versions record names such as `agent-1`, used as they are.

## Containers

A container stops the moment its main process exits, which also kills the plugin's detached deliverer. Templates in
[`deploy/`](deploy):

- [`entrypoint.sh`](deploy/entrypoint.sh) runs DSH, forwards SIGTERM / SIGINT, and after DSH exits delivers what is
  left (`node dsh-cls-observability.mjs --flush`) before the container stops;
- [`Dockerfile.snippet`](deploy/Dockerfile.snippet) adds the plugin (checksum-verified), the entrypoint and a patch file
  to an image that has DSH; no credentials go into the image;
- [`k8s/deployment.yaml`](deploy/k8s/deployment.yaml): credentials from a Secret, the CLS intranet endpoint, `DSH_HOME`
  on a PVC (spans left by a crashed or evicted pod are delivered by the next one), a grace period that covers the
  flush, and an optional native sidecar running `--relay`.

Commands of the plugin file (they read the same `CLS_AGENTOBS_*` variables):

| Command | Does |
|---|---|
| `node dsh-cls-observability.mjs --selftest [dir]` | Check configuration, outbox and CLS credentials / topic without writing data |
| `node dsh-cls-observability.mjs --flush [dir]` | Deliver the outbox and journals of dead processes once; exit 0 when empty |
| `node dsh-cls-observability.mjs --relay [dir]` | Keep delivering every `CLS_AGENTOBS_RELAY_INTERVAL_MS` (5000); final flush on SIGTERM |

The default directory is `$DSH_HOME/agentobs/outbox` (or `CLS_AGENTOBS_DATA_DIR`).

For rotating credentials without restarting DSH, point `CLS_AGENTOBS_CREDENTIALS_FILE` at a file your secret agent
updates; it is re-read when it changes.

## Configuration

All variables are read from the real process environment only. `$DSH_HOME/.env` is also accepted when
`CLS_AGENTOBS_TRUST_USER_ENV=true` is set in the process environment; a project `.env` is always ignored.

| Variable | Default | Meaning |
|---|---|---|
| `CLS_AGENTOBS_ENABLED` | – | `true` to enable |
| `CLS_AGENTOBS_REGION` | – | CLS region, e.g. `ap-shanghai` (builds the endpoint) |
| `CLS_AGENTOBS_TOPIC_ID` | – | AgentObs trace topic |
| `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` | – | Credentials (Basic auth to the CLS OTLP endpoint) |
| `CLS_AGENTOBS_CREDENTIALS_FILE` | – | Instead of the two above: JSON `{secretId, secretKey}` or `KEY=value` lines; re-read when it changes |
| `CLS_AGENTOBS_NETWORK` | public | `internal` uses the `tencentyun.com` intranet endpoint |
| `CLS_AGENTOBS_ENDPOINT` | – | Send to an OTLP/HTTP endpoint instead (collector, relay); https, or http on loopback / with `CLS_AGENTOBS_ALLOW_HTTP=true` (credentials are never sent over http to another host) |
| `CLS_AGENTOBS_CAPTURE_CONTENT` | `truncate` | Message and tool content: `truncate` / `full` / `off` (also `true` / `false`); `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` is honoured too |
| `CLS_AGENTOBS_CONTENT_MAX_CHARS` | `32000` | Per-field limit in `truncate` mode |
| `CLS_AGENTOBS_REDACT` | `on` | Mask secrets in captured content (see below); `off` to disable |
| `CLS_AGENTOBS_REDACT_PATTERNS` | – | Extra patterns: JSON array of regular expressions, e.g. `["EMP-\\d{6}"]` |
| `CLS_AGENTOBS_INCLUDE_AUXILIARY` | `true` | Record auxiliary model calls (compaction, title, auto review) so token totals and cost are complete; `false` to skip them |
| `CLS_AGENTOBS_SAMPLE_RATIO` | `1` | Per-session sampling |
| `CLS_AGENTOBS_SERVICE_NAME` | `deepseek-harness` | `service.name` |
| `CLS_AGENTOBS_ENVIRONMENT` | – | `deployment.environment.name` |
| `CLS_AGENTOBS_ENTRY_TYPE` / `_ENTRY_PLATFORM` | from profile | Override `gen_ai.entry.type` / `gen_ai.entry.platform` |
| `CLS_AGENTOBS_USER_ID` / `_USER_NAME` | – | `gen_ai.user.id` / `gen_ai.user.name` |
| `CLS_AGENTOBS_CUSTOM_ATTRIBUTES` | – | `k=v,k2=v2` → `agent.custom.k` on every span (secret-like keys are dropped) |
| `CLS_AGENTOBS_DATA_DIR` | `$DSH_HOME/agentobs/outbox` | Outbox directory; absolute path, owned by the DSH user (a symlink or someone else's directory is refused) |
| `CLS_AGENTOBS_DETACHED_DELIVERY` | `true` | Deliver spans spilled at exit from a detached process |
| `CLS_AGENTOBS_JOURNAL` | `true` | Journal spans to disk before sending (survives a crash); `false` keeps them in memory only |
| `CLS_AGENTOBS_EXPORT_TIMEOUT_MS` | `15000` | Per request |
| `CLS_AGENTOBS_SHUTDOWN_TIMEOUT_MS` | `3500` | In-process delivery budget at exit (DSH force-exits after 5 s) |
| `CLS_AGENTOBS_MAX_QUEUE_SPANS` | `20000` | In-memory queue bound (spans) |
| `CLS_AGENTOBS_MAX_QUEUE_MB` | `256` | In-memory queue bound (estimated size); beyond either bound the oldest spans move to the outbox |
| `CLS_AGENTOBS_DEBUG` | `false` | Diagnostics on stderr |

`gen_ai.entry.type` follows the DSH profile: `headless` → `cli`, `web` → `web`, `desktop` → `desktop`,
`sdk` / `sdk-minimal` → `sdk`, `acp` → `acp`, a custom profile → its name. The profile name itself is also recorded as
`agent.custom.dsh_profile`.

## What is recorded

| Span | Name | Notes |
|---|---|---|
| entry | `enter_application` | One per turn; the turn's prompt and final answer; `agent.custom.trigger` tells user prompts from automatic continuations |
| agent | `invoke_agent <name>` | `main`, or the subagent's name (see "Good to know"); subagents have `gen_ai.operation.name=invoke_subagent` and `gen_ai.agent.scope=subagent`. A subagent turn running inside its parent's trace has no entry: its agent span hangs off the tool call that started it |
| step | `react round_<N>` | One per model step |
| chat | `chat <model>` | Usage (cache read/miss, reasoning), time to first token, finish reason, request parameters. Input is the full context on a session's first call, then only what each call added (`gen_ai.input.messages_delta`); `gen_ai.input.messages.hash` covers the full context |
| tool | `execute_tool <name>` | Arguments, result, error; execution time excludes human approval waits; PTC inner calls nest under `run_code` |

A subagent reports the `gen_ai.session.id` of the task that started it, so session analysis and cost cover the whole
task; its turns get their own segment (`<task>:<child>:t<N>`) and its own DSH session id stays in `gen_ai.agent.id`.

Trace and span ids are derived from the session log, so a span is identified the same way however often it is sent.
Delivery is at least once; a duplicate can only occur when a request succeeded but the process died before its
response arrived.

### Content and privacy

Message and tool content is captured by default (truncated), because the CLS AgentObs console shows chat input/output
and tool arguments/results. It can contain anything users and tools exchange. Set `CLS_AGENTOBS_CAPTURE_CONTENT=off`
to send structure, timing and usage only.

Before content leaves the process, secrets are masked as `[REDACTED:<rule>]` (the span is marked
`agent.custom.content_redacted` with the rule names in `agent.custom.redacted_types`):

- **secrets this host holds**, wherever and however they appear (`printenv` output, a quoted value, prose): the CLS
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
appears on its own, with no key name next to it and is not in this host's environment — it is indistinguishable from
a hash or an id. Add your own formats with `CLS_AGENTOBS_REDACT_PATTERNS`, or turn content capture off.

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
