# Security

## Reporting

Report vulnerabilities privately through GitHub security advisories of this repository, not in public issues.

## What the plugin does with your data

The plugin runs inside the DeepSeek Harness process and sees everything the agent sees.

| Data | Where it goes |
|---|---|
| Message and tool content | Sent to your CLS topic when content capture is on (default `truncate`); redacted first (see README, "What is recorded"). `CLS_AGENTOBS_CAPTURE_CONTENT=off` sends structure, timing and token usage only |
| CLS credentials | Read from the process environment or `CLS_AGENTOBS_CREDENTIALS_FILE`, never from a project `.env`. Sent only as the `Authorization` header to the configured endpoint over HTTPS (or to a loopback address). Never logged, never written to disk by the plugin |
| Other credentials in the environment (`*_API_KEY`, `*_TOKEN`, …) | Read only to mask their values in captured content |
| Local files | `$DSH_HOME/agentobs/outbox` (or `CLS_AGENTOBS_DATA_DIR`, absolute paths only): spans not yet delivered, a write-ahead journal, and two small ledgers. Directory `0700`, files `0600`; the plugin refuses a directory that is a symlink or owned by another user |
| Network | Only the configured endpoint (default `https://<region>.cls.tencentcs.com/v1/traces`). Redirects are refused |
| Processes | At exit, a detached `node` process delivers spilled spans; it receives the endpoint, topic and credentials through its environment (not its command line) |

## Isolation from the host

- Every event handler is guarded: an error inside the plugin is logged (rate-limited) and never reaches DSH.
- The model stream wrapper passes every chunk, error and cancellation through unchanged.
- Sending is asynchronous and batched; journal fsync runs off the main thread; crash recovery runs after startup.
- Memory is bounded by span count and by size (`CLS_AGENTOBS_MAX_QUEUE_SPANS`, `CLS_AGENTOBS_MAX_QUEUE_MB`); overflow goes to disk, the outbox is capped at 512 MiB.
- Redaction patterns are linear-time on adversarial input and run only on the part of a field that is kept.

## Limits

- Redaction is best effort: a third-party secret without a recognisable prefix, not next to a credential-named key and
  not in the host environment, cannot be told apart from a hash or an id.
- Spans are as sensitive as the conversations they record: restrict access to the CLS topic accordingly.
