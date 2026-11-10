# Reliability: how spans survive exits, crashes and lost pods

[中文](reliability.zh-CN.md)

This page explains where the plugin keeps spans it has not delivered yet, what happens to them in each kind of failure,
and what the plugin needs from the environment you run DSH in. It is meant for your deployment review. How you deploy
DSH itself is up to you; the plugin adapts to it.

## The short version

- Every span is written to a local journal **before** it is sent, and forgotten only after CLS has acknowledged it.
- At a normal exit, anything unsent is written to an outbox directory and delivered by a short-lived background process.
- Whatever is left on disk — after a crash, a `kill -9`, an OOM kill, a deleted pod — is delivered by the **next**
  plugin process that starts with the same directory, on any machine that mounts it.
- So the guarantee holds as long as the directory survives and something eventually starts on it again — or, where
  your environment ends together with DSH, as long as it runs `--flush` before it goes.

## Where the data lives

The plugin owns one directory: `$DSH_HOME/agentobs/outbox`, or `CLS_AGENTOBS_DATA_DIR` (an absolute path). DSH only
provides `$DSH_HOME`; everything in this directory is written and removed by the plugin. It holds trace data that is
already converted to spans, not DSH sessions (DSH keeps its own session logs under `$DSH_HOME/sessions`).

| File | What it is | Removed when |
|---|---|---|
| `<time>-<pid>-<rand>.wal` | Write-ahead journal segment (≤ 4 MiB each): one line per span as it is produced, then acknowledgement lines | Every span in it is acknowledged, or it is converted to outbox files |
| `<time>-<pid>-<rand>.otlp.gz` | A ready-to-send request (gzip OTLP/protobuf, ≤ 512 spans / ~4 MiB) | CLS accepted it, or rejected its content (HTTP 400 / 413) |
| `… .sending-<pid>.<namespace>` | Either kind of file, claimed by the process sending or writing it | The claim is released or the file is removed |
| `open-spans`, `open-spans-<pid>.<namespace>` | Which spans were already sent for turns still in progress | Folded together at start; kept under 4 MiB |
| `closed-turns` | Turns already completed after a crash | Kept under 4 MiB |
| `*.corrupt` | An unreadable journal set aside | Never (inspect, then delete) |

The directory is `0700` and the files `0600`. The plugin refuses a directory that is a symbolic link or belongs to
another user. The outbox is capped at 512 MiB; beyond that new spills are refused and logged.

## Life of a span

```
produced ──► journal (.wal) ──► memory queue ──► sent in a batch ──► acknowledged ──► forgotten
                                    │
               at a normal exit     ├──► outbox file (.otlp.gz) ──► background deliverer ──► removed
               queue too large      └──► outbox file (.otlp.gz) ──► sent by the running host
```

- **Journal.** Written synchronously when the span is produced; the operating system is asked to flush it to disk every
  200 ms (off the host's main thread).
- **Queue.** Sent every 2 s or every 512 spans. On a network error, a timeout, HTTP 408 / 429 / 5xx it retries with
  backoff (1 s up to 60 s); on 401 / 403 / 404 (credentials, topic) it pauses 5 minutes and keeps everything.
- **Normal exit.** DSH gives plugins about 5 s. The plugin writes everything unsent to outbox files at once, starts a
  detached deliverer for them, and keeps sending in-process until its own deadline (3.5 s by default).

## Who sends a file that was left behind

Any plugin process using the directory — a DSH host, the background deliverer, `--flush`, `--relay` — sends outbox files
it finds, and converts journals of processes that are gone into outbox files. Each file is claimed by renaming it with
the owner's tag (`<pid>.<namespace>`) before it is touched, so two processes never send the same file.

Deciding that an owner is gone:

| Owner | Rule |
|---|---|
| Same PID namespace (same machine or same container) | Its process id no longer exists |
| Another PID namespace (another pod, a sidecar) | Its file has not been refreshed for **2 minutes**. Live owners refresh their files every 30 s |

A running host checks at start and then every minute, so data left by a dead pod is picked up by its replacement within
about two to three minutes of the old pod's death.

## What happens in each failure

| Event | Unsent spans | Delivered by |
|---|---|---|
| Normal exit (task done, Ctrl-C, SIGTERM) | Outbox files | The background deliverer at once; otherwise the next start |
| `kill -9`, OOM kill, host crash | Journal | The next plugin process on the directory |
| CLS unreachable for a while | Memory, then outbox files when the queue is full (20 000 spans or 256 MiB) | The running host once CLS is back |
| Credentials or topic wrong | Kept, sending paused | The running host after the fix (restart needed for a new environment) |
| Power loss of the machine | Journal, except possibly the last ~200 ms not yet flushed to disk | The next plugin process |
| A supervisor stops the service and every process in it (systemd's default) | Outbox files; the background deliverer is stopped too | `--flush` after the stop (e.g. `ExecStopPost=`); otherwise the next start |
| Container exits (its main process ends) | Outbox files; the background deliverer dies with the container | A wrapper such as `examples/container/entrypoint.sh` runs `--flush` before the container stops; otherwise the next container on the volume |
| A short-lived environment ends (CI job, serverless, sandbox) | Outbox files, discarded with the environment unless flushed | `--flush` as the environment's last step |
| Pod deleted (`kubectl delete pod`) | As a normal exit, within the grace period | The entrypoint's flush; otherwise the next pod on the volume |
| Pod killed or evicted, node lost | Journal or claimed outbox files on the volume | The next pod that mounts the volume, on any node |
| Directory lost (`emptyDir`, node disk wiped) | **Lost** | — |
| Nothing ever starts on the directory again | Kept on disk, not sent | Run `node dsh-cls-observability.mjs --flush <dir>` |

Turns interrupted by a crash also get their missing entry, agent, step and tool spans — when DSH resumes that session
(DSH writes the closing events then). A crashed session that is never resumed keeps that turn without those spans.

## Duplicates

Span ids are derived from the session, so a resent span has the same id. Spans already acknowledged are never resent,
and crash closure skips what the dead process had already sent. The one case that produces a duplicate: a request CLS
accepted but whose response never reached the process before it died; that batch is sent again.

## What the plugin needs from your environment

Two conditions, whatever the deployment:

1. **The data directory outlives the DSH process** (`$DSH_HOME/agentobs/outbox`, or `CLS_AGENTOBS_DATA_DIR`), and
   something starts on it again later — DSH itself, `--flush` or `--relay`.
2. **Where the environment ends together with DSH, it delivers what is left first** (`--flush`).

How that maps to common setups:

| Where DSH runs | Data directory | Delivery after DSH stops |
|---|---|---|
| Workstation, VM | Local disk | Background deliverer; otherwise the next start |
| Service under a supervisor (systemd, …) | Local disk | `--flush` after the stop (e.g. `ExecStopPost=`), or the next start |
| Your program, through the TypeScript SDK | The launch's `DSH_HOME` | Background deliverer (your program keeps running) |
| Containers | A volume, not the container's own filesystem | A wrapper that runs `--flush` after DSH; otherwise the next container on the volume |
| Kubernetes | A PersistentVolumeClaim that replacement pods mount again, one pod per volume (ReadWriteOnce disks such as CBS): one replica with `strategy: Recreate`, or a StatefulSet with `volumeClaimTemplates`; not `emptyDir` | A wrapper, or the `--relay` sidecar; a grace period covering DSH's shutdown plus the flush (60 s is ample); data of a lost pod is taken over by the next pod |
| Short-lived environments (CI, serverless, sandboxes) | Discarded with the environment | `--flush` as the last step; a hard kill loses what was not sent |

The `--relay` sidecar or process is safe next to running hosts: claims are respected across PID namespaces. The files
in `examples/` show one way to do each of these; adapt them to your setup.

## How it was verified

- Unit and fault-injection tests: the journal, outbox claims, cross-namespace leases, recovery of dead processes'
  journals, crash closure (cross-checked against DSH's own closing logic over 6 000 crash points).
- Real DSH on Linux and macOS: a process killed mid-task and resumed; spans all delivered, none duplicated.
- TKE (Kubernetes 1.36, CBS disks, two x86_64 nodes) with the manifests in `examples/kubernetes`, each run compared
  span by span with what the session logs say was produced:

| Scenario | Result |
|---|---|
| Job, CLS intranet endpoint, entrypoint flush | Exact |
| `kubectl delete pod` mid-task | Exact; pod gone in 1–2 s |
| Every process killed (`kill -9`) mid-task, replacement on the other node | Exact; replacement took the journal over within a minute of starting |
| A Deployment's pod force-deleted mid-task | Exact; the Deployment's new pod mounted the same disk and delivered what the old one left |
| `dsh web` with the relay sidecar | Exact; the sidecar never took files from the live host |

The cluster scenarios are scripted in `scripts/tke-verify.ts`. The supervisor (systemd) and short-lived rows above
follow from the same mechanism and have not been run end to end.
