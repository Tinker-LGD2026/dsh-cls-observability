# Changelog

## Unreleased

- Docs: the Kubernetes walkthrough no longer turns off DSH's command sandbox. Using the plugin needs no change to
  DSH's sandbox or permissions; the main flow is the plugin file, its patch, environment, credentials and a disk.
  A separate section covers agents that run commands inside the container (DSH's own behavior, unrelated to the
  plugin): the error DSH gives when no sandbox is usable, tested results on TKE and local Docker, and the options
  (remote sandbox, or the container as the isolation boundary) with their risks.

## 0.1.1 — 2026-11-10 (preview)

No change to the plugin's behavior: the plugin file differs from 0.1.0 only in its version.

- Docs: [Kubernetes from scratch](docs/kubernetes.md) ([简体中文](docs/kubernetes.zh-CN.md)) — build an image, try it
  locally, run a Job and a web Deployment on TKE, find the trace in CLS; run as written on TKE (Kubernetes 1.36).
- Examples: `Dockerfile.snippet` defaults to 0.1.1.
- Releases are published from GitHub Actions with npm trusted publishing (OIDC), with provenance.

## 0.1.0 — 2026-11-10 (preview)

First release. Exports DeepSeek Harness 0.2.x runs to Tencent Cloud CLS AgentObs as OpenTelemetry traces. Verified
against the published `@deepseek-ai/dsh@0.2.2-rc.1` on Linux arm64 / x86_64, macOS, and TKE (Kubernetes 1.36).

### Traces

- Five span levels per turn: `enter_application` → `invoke_agent` → `react round_N` → `chat <model>` /
  `execute_tool <tool>`, with the CLS AgentObs fields; ids `<session>:t<N>:s<M>`.
- Token usage (cache read / miss, reasoning), time to first token, finish reasons, request parameters.
- Chat input: full context on a session's first call, then only what each call added
  (`gen_ai.input.messages_delta`, `agent.custom.input_delta_start`); back to a full report after compaction.
- PTC (`run_code`) inner tool calls nested under the call; MCP tools typed `mcp`; approvals and retries as events.
- Subagents nested under the tool call that started them, at any depth, in the session of the task that started them
  (session analysis and cost cover the whole task).
- Auxiliary model calls (session title, compaction, auto review) recorded with their prompt and reply, so token totals
  are complete; `CLS_AGENTOBS_INCLUDE_AUXILIARY=false` skips them.
- Entry type from the DSH profile: `cli`, `web`, `sdk`, `acp`, `desktop`, or a custom profile's name.

### Delivery

- Spans are journaled to disk before they are sent; a host killed outright loses nothing (the next start resends).
- At exit unsent spans go to an outbox delivered by a detached process; during outages overflow goes to disk.
- A turn interrupted by a crash gets its root spans when DSH resumes the session; nothing already sent is repeated.
- 401 / 403 / 404 pause delivery and keep the data; other 4xx isolate the offending span.
- Commands: `--selftest` (checks configuration, outbox, credentials and topic without writing data), `--flush`,
  `--relay`; examples for containers (Dockerfile lines, a flush-on-exit wrapper) and Kubernetes (Deployment, Job,
  relay sidecar) — the plugin works however you run DSH.
- Data left by a killed pod is taken over by the next pod, on any node: claims carry the PID namespace, and a
  claim from another namespace is abandoned once it has not been refreshed for two minutes.

### Content and security

- Content captured by default (truncated at 32 000 characters per field), redacted first: secrets this host holds,
  vendor key formats, credential-named keys (including CLI flags and Chinese wording). `CLS_AGENTOBS_REDACT=off`,
  `CLS_AGENTOBS_CAPTURE_CONTENT=off`.
- Configuration only from the real process environment; credentials never logged, written to disk, or sent over plain
  http to another host; private outbox directory; spans capped at the CLS 8 MB limit; memory bounded by count and size.
- See [SECURITY.md](SECURITY.md).

### Known limits

- No temporary (STS) credentials: the CLS AgentObs endpoint documents SecretId / SecretKey only.
- A crashed session that is never resumed keeps the interrupted turn without its root spans.
- DSH 0.2.2-rc.1 records no subagent names: the task description is used when content capture is on.
- `desktop` not verified.
