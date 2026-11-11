# From scratch: DeepSeek Harness on Kubernetes, reporting to CLS

[简体中文](kubernetes.zh-CN.md)

- Versions: DSH `0.2.2-rc.1`, plugin `dsh-cls-observability` `0.1.1`
- Example environment: Tencent Cloud TKE (x86_64 nodes) + CLS in `ap-shanghai`

This walkthrough takes one concrete task from nothing to a trace: build an image, try it locally, run a one-off task on Kubernetes (a Job), and look at the result in CLS. The advanced part runs the DSH web UI as a long-running Deployment.

**Tested (2026-11-11)**: the Dockerfile and YAML were extracted from this document as written, with only the image address and topic id filled in, and run on TKE (Kubernetes 1.36, x86_64 nodes, `cbs` disks):

- Image: built as in section 2; the plugin 0.1.1 checksum matched.
- Job: the log shows the model's answer and `0 left`; CLS has 1 trace with 5 spans, no duplicates, no orphans, entry type `cli`.
- Deployment: a task started in the web UI over `kubectl port-forward`; CLS has 1 trace with 5 spans, entry type `web`.
- The findings in section 9 were tested separately on the same cluster.

The image run on TKE carried plugin 0.1.0, whose code is the same as 0.1.1.

**Using the plugin takes four things: the plugin file and one patch in the image, environment variables, credentials, and a disk.** The plugin needs no other change to DSH's settings, sandbox and permissions included. How DSH runs tools is up to your agent and unrelated to the plugin; if your agent runs commands inside the container, see [section 9](#9-if-your-agent-runs-commands-in-the-container).

---

## 0. The big picture

One sentence to remember: **the plugin is a file the DSH process loads at startup; Kubernetes only hands things to DSH.**

Kubernetes hands DSH three things:

```
┌──────────────────────── Image (you build it once) ─────────────────────┐
│  DSH                                                                    │
│  plugin file  /opt/dsh-cls-observability/dsh-cls-observability.mjs      │
│  patch        agentobs.patch.yml   tells DSH to load that plugin file   │
│  wrapper      entrypoint.sh        sends what is left after DSH exits   │
└─────────────────────────────────────────────────────────────────────────┘
          ▲ brought into the pod by the image
┌─────────┴──────────────────────── Pod ─────────────────────────────────┐
│   DSH process (plugin loaded)                                           │
│     ├─ reads environment variables ◀── Secret: CLS keys, DeepSeek key   │
│     │                              ◀── plain settings: region, topic    │
│     └─ reads/writes /data/dsh      ◀── PVC: a disk that outlives pods   │
└─────────────────────────────────────────────────────────────────────────┘
          │ the plugin sends traces to
          ▼
      CLS trace topic (view it in the console)
```

The plugin runs inside the DSH process: it reads DSH's run events, writes what is waiting to be sent under `/data/dsh`, and sends it to CLS over HTTPS. None of this goes through the command sandbox DSH applies to the agent's tools.

Terms used here:

| Term | In one line | Role in this walkthrough |
|---|---|---|
| Image / Dockerfile | A packaged runtime; the Dockerfile is its recipe | Holds DSH, the plugin file, the patch and the wrapper |
| Pod | The smallest thing Kubernetes runs: one or more containers | DSH runs in a pod |
| Job | Runs a pod once to completion, without restarting it | Section 6, a one-off task |
| Deployment | Keeps a pod running and replaces it when it dies | Section 8, the long-running web UI |
| Secret | A Kubernetes object for credentials, kept out of images and manifests | Holds the CLS keys and the DeepSeek API key |
| PVC | A request for a persistent disk | Holds DSH's data and the spans not yet sent |
| patch | A fragment of DSH configuration: which plugins to load, what to change | Makes DSH load the plugin |
| Environment variables | `NAME=value` pairs given to a process | All plugin settings come this way |

---

## 1. What you need

| What | Where to get it | Used for |
|---|---|---|
| CLS **trace topic id** | Create a trace topic for Agent observability in the CLS console and copy its id | `CLS_AGENTOBS_TOPIC_ID` |
| The topic's **region** | e.g. `ap-shanghai` | `CLS_AGENTOBS_REGION` |
| Tencent Cloud **SecretId / SecretKey** | Preferably a sub-account allowed only `cls:UploadLog` on that topic | Secret |
| **DeepSeek API key** | DeepSeek platform | Secret (DSH calls the model with it; unrelated to the plugin) |
| An **image registry** | e.g. Tencent Container Registry (TCR); note its address | Pushing the image, pulling it in the cluster |
| **Docker** with buildx on your machine | Docker Desktop, OrbStack, … | Building the image |
| **kubectl** connected to your TKE cluster | Download the kubeconfig from the TKE console | Sections 4–11 |

Check that kubectl reaches the cluster:

```bash
kubectl get nodes
```

If it lists your nodes, you are connected.

---

## 2. Build the image

Create a directory (say `dsh-image/`) with **2 files**. If you already have your own DSH image, only add the "plugin" and "patch file" parts of 2.2 to your Dockerfile (see also [`examples/container/Dockerfile.snippet`](../examples/container/Dockerfile.snippet)).

### 2.1 `agentobs.patch.yml`: load the plugin

```yaml
- insert:
    - id: cls-agentobs
      name: /opt/dsh-cls-observability/dsh-cls-observability.mjs
```

This inserts a plugin with id `cls-agentobs` into DSH, loaded from the path in `name`. The path must match where the Dockerfile below puts the plugin file. This file is the only DSH configuration the plugin needs.

### 2.2 `Dockerfile`: the recipe

```dockerfile
# syntax=docker/dockerfile:1

# ---------- Stage 1: fetch DSH ----------
# Fetched on your machine's own architecture, then handed to stage 2 (npm under x86 emulation on
# Apple silicon can leave packages half extracted).
FROM --platform=$BUILDPLATFORM node:24-bookworm AS fetch
ARG DSH_VERSION=0.2.2-rc.1
RUN mkdir -p /opt/dsh && cd /opt/dsh && echo '{"name":"dsh","private":true}' > package.json \
 && npm_config_cpu=x64 npm_config_os=linux npm_config_libc=glibc npm_config_ignore_scripts=true \
    npm install --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}"

# ---------- Stage 2: the final image ----------
FROM node:24-bookworm
COPY --from=fetch /opt/dsh /opt/dsh
RUN cd /opt/dsh && npm rebuild
ENV PATH=/opt/dsh/node_modules/.bin:$PATH

# The plugin, from npm, checked against the published SHA-256; plus the package's entrypoint.sh wrapper.
ARG AGENTOBS_VERSION=0.1.1
ARG AGENTOBS_SHA256=6d1e7287f7e641b589df953d4d715952fae852eff162653afebbfe5860651796
RUN mkdir -p /opt/dsh-cls-observability && cd /tmp \
 && npm pack "dsh-cls-observability@${AGENTOBS_VERSION}" --silent \
 && tar -xzf "dsh-cls-observability-${AGENTOBS_VERSION}.tgz" \
 && cp package/dist/dsh-cls-observability.mjs package/examples/container/entrypoint.sh /opt/dsh-cls-observability/ \
 && chmod 0755 /opt/dsh-cls-observability/entrypoint.sh \
 && rm -rf package ./*.tgz \
 && echo "${AGENTOBS_SHA256}  /opt/dsh-cls-observability/dsh-cls-observability.mjs" | sha256sum -c -

# The patch file that makes DSH load the plugin.
COPY agentobs.patch.yml /opt/dsh-cls-observability/

RUN mkdir -p /work && chown 1000:1000 /work
WORKDIR /work

# The wrapper runs your command (DSH), then delivers what the plugin has not sent yet.
ENTRYPOINT ["/opt/dsh-cls-observability/entrypoint.sh"]
```

Part by part:

| Part | What it does | Why |
|---|---|---|
| Stage 1 | Installs DSH 0.2.2-rc.1 with npm | DSH is an npm package. `npm_config_cpu=x64` fetches the x86_64 build, as TKE nodes usually are; for ARM nodes use `arm64` (and `--platform linux/arm64`) |
| Start of stage 2 | Copies DSH, completes it with `npm rebuild`, puts `dsh` on the PATH | `dsh` then works as a command in the container |
| Plugin | Fetches the plugin package, takes out the plugin file and `entrypoint.sh`, and **checks the SHA-256** | A mismatch fails the build, so the image holds exactly the published file. The plugin is that one file with no dependencies. To change versions, change `AGENTOBS_VERSION` and `AGENTOBS_SHA256` together; the checksum is the `.sha256` file of the [GitHub release](https://github.com/Tinker-LGD2026/dsh-cls-observability/releases) |
| Patch file | Copies the file from 2.1 into the image | DSH is pointed at it with `--patch` |
| ENTRYPOINT | The container runs the wrapper, which runs the command you pass | A container ends the moment its main process exits. The wrapper waits for DSH to exit, delivers what is left, then lets the container end |

**The image holds no credentials**: they come from a Kubernetes Secret at runtime.

### 2.3 Build and push

With Tencent Container Registry (personal edition) as the example (replace `<namespace>`):

```bash
cd dsh-image
docker login ccr.ccs.tencentyun.com
docker buildx build --platform linux/amd64 \
  -t ccr.ccs.tencentyun.com/<namespace>/dsh-agentobs:0.1.1 \
  --push .
```

- `--platform linux/amd64`: builds an x86_64 image even on an Apple silicon Mac.
- `--push`: pushes to the registry when the build finishes.

`/opt/dsh-cls-observability/dsh-cls-observability.mjs: OK` in the build log means the plugin file matched its checksum.

---

## 3. (Recommended) Try the image locally first

Problems are much easier to diagnose on your machine than in a cluster.

Put the settings in your shell. `read -s` does not echo and keeps the values out of your shell history:

```bash
export CLS_AGENTOBS_REGION=ap-shanghai
export CLS_AGENTOBS_TOPIC_ID=<your trace topic id>
read -rs -p 'SecretId: '  TENCENTCLOUD_SECRET_ID  && echo && export TENCENTCLOUD_SECRET_ID
read -rs -p 'SecretKey: ' TENCENTCLOUD_SECRET_KEY && echo && export TENCENTCLOUD_SECRET_KEY
read -rs -p 'DeepSeek API Key: ' DEEPSEEK_API_KEY && echo && export DEEPSEEK_API_KEY
IMG=ccr.ccs.tencentyun.com/<namespace>/dsh-agentobs:0.1.1
```

`docker run -e NAME` without a value passes your shell's variable of that name, so no credential appears on the command line.

### 3.1 Self-test: checks the configuration, writes no data

```bash
docker run --rm --platform linux/amd64 \
  -e CLS_AGENTOBS_ENABLED=true -e CLS_AGENTOBS_REGION -e CLS_AGENTOBS_TOPIC_ID \
  -e TENCENTCLOUD_SECRET_ID -e TENCENTCLOUD_SECRET_KEY \
  --entrypoint node "$IMG" /opt/dsh-cls-observability/dsh-cls-observability.mjs --selftest
```

Four `ok` lines mean all is well (`DSH_HOME` is not set locally, so the data directory is the default `~/.dsh`; on Kubernetes it is `/data/dsh` on the disk):

```
ok   configuration: endpoint https://ap-shanghai.cls.tencentcs.com/v1/traces, topic <topic id>, credentials from environment
ok   content: captured (truncated at 32000), redaction on
ok   outbox: /root/.dsh/agentobs/outbox writable, 0 files waiting
ok   destination: reachable, credentials and topic accepted (1109 ms)
```

| Line that says FAIL | Cause |
|---|---|
| `configuration` | A variable is missing; the line names it |
| `destination: credentials rejected` | Wrong SecretId / SecretKey, or the sub-account lacks `cls:UploadLog` |
| `destination: topic or endpoint not found` | Wrong topic id or region |
| `destination: not reachable` | No network path to CLS |

### 3.2 Run a real task

```bash
docker run --rm --platform linux/amd64 \
  -e CLS_AGENTOBS_ENABLED=true -e CLS_AGENTOBS_REGION -e CLS_AGENTOBS_TOPIC_ID \
  -e TENCENTCLOUD_SECRET_ID -e TENCENTCLOUD_SECRET_KEY -e DEEPSEEK_API_KEY \
  -e CLS_AGENTOBS_ENVIRONMENT=tutorial \
  "$IMG" \
  dsh --profile headless \
      --patch /opt/dsh-cls-observability/agentobs.patch.yml \
      'Reply with the single word: tutorial-ok'
```

The output ends with the model's answer `tutorial-ok`, followed by the wrapper's flush:

```
tutorial-ok
[cls-agentobs] flush: delivered 0 files, 0 left in .../agentobs/outbox
```

`0 left` means nothing is waiting. `delivered 0` is not an error: everything was sent while DSH ran, so the flush had nothing to do.

> **The most common mistake: argument order.** `--profile` and `--patch` must come **before** the task and app arguments such as `--json`. DSH hands everything from the first argument it does not know to the app, so a later `--patch` is ignored and the plugin is not loaded.

---

## 4. Put the credentials in a Secret

```bash
cat > secret.env <<'EOF'
TENCENTCLOUD_SECRET_ID=<SecretId>
TENCENTCLOUD_SECRET_KEY=<SecretKey>
DEEPSEEK_API_KEY=<DeepSeek API Key>
EOF
kubectl create secret generic dsh-agentobs --from-env-file=secret.env
rm secret.env
```

Each line becomes a key of the Secret, named after the left side. The YAML in section 6 turns all three into DSH environment variables with `envFrom`.

If your registry is private, let the cluster pull from it:

```bash
kubectl create secret docker-registry dsh-image-pull \
  --docker-server=ccr.ccs.tencentyun.com \
  --docker-username=<account id> --docker-password=<registry password>
```

---

## 5. Ask for a disk (PVC)

Save as `pvc.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: dsh-home
spec:
  accessModes: [ReadWriteOnce]      # attached to one node at a time
  storageClassName: cbs             # TKE cloud disk; 10Gi minimum
  resources:
    requests:
      storage: 10Gi
```

```bash
kubectl apply -f pvc.yaml
```

**Why a disk**: the plugin writes every span to `$DSH_HOME/agentobs/outbox` before sending it. When a pod is killed, evicted or loses its node, what was not delivered stays on the disk, and the next pod that mounts it delivers it, on any node. With `emptyDir` that data is lost with the pod. See [reliability.md](reliability.md).

---

## 6. Run a one-off task (Job)

Save as `job.yaml`, replacing `<image>` and `<trace topic id>`:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: dsh-task
spec:
  backoffLimit: 0                     # no retries
  template:
    spec:
      restartPolicy: Never
      terminationGracePeriodSeconds: 60   # time for DSH to stop and the flush
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000                 # lets user 1000 write the disk
        fsGroupChangePolicy: OnRootMismatch   # needed by DSH, see section 10
      # imagePullSecrets: [{ name: dsh-image-pull }]   # uncomment for a private registry
      containers:
        - name: dsh
          image: <image>
          args:                       # run by the image's ENTRYPOINT (the wrapper)
            - dsh
            - --profile
            - headless
            - --patch
            - /opt/dsh-cls-observability/agentobs.patch.yml
            - "Reply with the single word: tutorial-ok"
          env:
            - { name: DSH_HOME, value: /data/dsh }                     # DSH's data directory = the disk
            - { name: CLS_AGENTOBS_ENABLED, value: "true" }            # turns the plugin on
            - { name: CLS_AGENTOBS_REGION, value: ap-shanghai }
            - { name: CLS_AGENTOBS_NETWORK, value: internal }          # intranet when TKE and CLS share a region
            - { name: CLS_AGENTOBS_TOPIC_ID, value: <trace topic id> }
            - { name: CLS_AGENTOBS_ENVIRONMENT, value: tutorial }      # optional: filter by environment in CLS
          envFrom:
            - secretRef: { name: dsh-agentobs }                        # the three keys from section 4
          volumeMounts:
            - { name: dsh-home, mountPath: /data/dsh }
      volumes:
        - name: dsh-home
          persistentVolumeClaim: { claimName: dsh-home }
```

Run it and follow the log:

```bash
kubectl apply -f job.yaml
kubectl logs -f job/dsh-task
```

The log ends as in 3.2: the model's answer, then `[cls-agentobs] flush: delivered N files, 0 left`.

Notes:

- **`CLS_AGENTOBS_NETWORK=internal`**: when the cluster and the topic are in the same region, traffic stays on Tencent Cloud's intranet. Remove the line for different regions.
- **Self-test first**: set `args` to `["node", "/opt/dsh-cls-observability/dsh-cls-observability.mjs", "--selftest"]`, check for four `ok` lines, then switch back.
- **Your own task**: change the last argument. If the task makes the agent run commands in the container, read section 9 first.
- **Run again**: a Job runs once; delete and recreate it: `kubectl delete job dsh-task && kubectl apply -f job.yaml`.
- **Concurrent tasks**: a `ReadWriteOnce` disk serves one node at a time; give each concurrent task its own PVC.

---

## 7. Look at it in CLS

Open the topic's Agent observability page and find the task by time. With `CLS_AGENTOBS_ENVIRONMENT=tutorial` you can filter by environment.

The example task produced these 5 spans in CLS:

```
enter_application                  the turn's entry: user input, final answer
└─ invoke_agent main               the agent
   └─ react round_1                step 1
      ├─ chat deepseek-flash       the model's answer: tokens, time to first token, input and output
      └─ chat deepseek-flash       DSH titling the session in the background (first turn only; it runs
                                   alongside step 1, so it sits under it)
```

When the agent calls a tool, each call adds an `execute_tool <tool>` span under its step, with arguments, result and duration; a failed tool call is marked as an error and carries the error text. The agent name comes from the DSH profile: `invoke_agent main` from the command line (headless), `invoke_agent standard` from the web UI; the structure is the same.

---

## 8. Advanced: the DSH web UI as a Deployment

Three differences from the Job:

1. **No command line to add `--patch` to.** An init container copies `agentobs.patch.yml` to `$DSH_HOME/cordis.patch.yml` before DSH starts; DSH reads that file on every start.
2. **One pod per disk**: `replicas: 1` with `strategy: Recreate` (the old pod stops before the new one starts). For several replicas use a StatefulSet with a disk each.
3. **An optional relay sidecar** shares the disk and delivers what is left every 5 seconds.

Save as `deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dsh-web
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector:
    matchLabels: { app: dsh-web }
  template:
    metadata:
      labels: { app: dsh-web }
    spec:
      terminationGracePeriodSeconds: 60
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        fsGroupChangePolicy: OnRootMismatch
      # imagePullSecrets: [{ name: dsh-image-pull }]
      initContainers:
        # 1. The patch, in place before DSH starts: DSH reads $DSH_HOME/cordis.patch.yml on every start
        - name: agentobs-patch
          image: <image>
          command: ["/bin/sh", "-c"]
          args:
            - test -f /data/dsh/cordis.patch.yml || cp /opt/dsh-cls-observability/agentobs.patch.yml /data/dsh/cordis.patch.yml
          volumeMounts:
            - { name: dsh-home, mountPath: /data/dsh }
        # 2. Optional relay sidecar (Kubernetes 1.29 or later). Delete it if you do not need it
        - name: agentobs-relay
          image: <image>
          restartPolicy: Always
          command: ["node", "/opt/dsh-cls-observability/dsh-cls-observability.mjs", "--relay"]
          env: &agentobs-env
            - { name: DSH_HOME, value: /data/dsh }
            - { name: CLS_AGENTOBS_ENABLED, value: "true" }
            - { name: CLS_AGENTOBS_REGION, value: ap-shanghai }
            - { name: CLS_AGENTOBS_NETWORK, value: internal }
            - { name: CLS_AGENTOBS_TOPIC_ID, value: <trace topic id> }
            - { name: CLS_AGENTOBS_ENVIRONMENT, value: production }
          envFrom: &agentobs-secret
            - secretRef: { name: dsh-agentobs }
          volumeMounts:
            - { name: dsh-home, mountPath: /data/dsh }
      containers:
        - name: dsh
          image: <image>
          args: ["dsh", "--profile", "web", "--no-open", "--port", "18080"]
          env: *agentobs-env
          envFrom: *agentobs-secret
          volumeMounts:
            - { name: dsh-home, mountPath: /data/dsh }
      volumes:
        - name: dsh-home
          persistentVolumeClaim: { claimName: dsh-home }
```

`&agentobs-env` / `*agentobs-env` is YAML's "define once, refer to it elsewhere": the sidecar and DSH share one configuration.

```bash
kubectl delete job dsh-task --ignore-not-found   # free the disk: one pod at a time
kubectl apply -f deployment.yaml
kubectl port-forward deploy/dsh-web 18080:18080
```

**The address to open is in the DSH log.** The web UI needs an access token; `http://127.0.0.1:18080` alone asks for authentication:

```bash
kubectl logs deploy/dsh-web -c dsh | grep 'dsh web:'
# dsh web: http://127.0.0.1:18080/?token=<token>
```

Open that whole address (with `?token=`) in your browser. The browser then stays signed in. The token works like a password for the web UI: do not share it.

> **If local port 18080 is taken** (another ssh tunnel, say), `port-forward` may bind only IPv6 and your browser reaches the other program: a 401 or some other page. Check with `lsof -nP -iTCP:18080 -sTCP:LISTEN`. If something is there, forward another local port, e.g. `kubectl port-forward deploy/dsh-web 28080:18080`, and open the logged address with `18080` changed to `28080`.

> The DSH web UI listens only on `127.0.0.1` inside the pod, hence `kubectl port-forward` here. To serve it to others, put an authenticating entry point in front of it; do not expose it directly with a Service or an Ingress.

While the web UI runs, `/data/dsh/agentobs/outbox` keeps two files, `*.wal.sending-*` (the current write-ahead journal) and `open-spans-*` (spans of turns in progress). That is expected; see [reliability.md](reliability.md).

---

## 9. If your agent runs commands in the container

**This section is about DSH's own behavior, not the plugin: it is the same with or without the plugin.** It matters only if your agent runs commands **locally**, in the container DSH runs in, with a tool such as `bash`. Skip it when:

- the agent runs no local commands: plain conversation, or only API and MCP tools;
- tools run remotely ("brain and hands" split): in e2b, Tencent Cloud Agent Runtime or another remote sandbox. DSH's local sandbox covers only the child processes DSH starts itself, not remote sandboxes.

### 9.1 What you will see

By default DSH runs each command the agent asks for inside a sandbox that lets it write only the working directory; on Linux that sandbox is bwrap or the kernel's Landlock. **When neither is usable, DSH refuses to run the command rather than quietly lifting the restriction.** The tool returns:

```
sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host;
refusing to run the command unconfined. ...
```

The plugin keeps working: that tool call is an `execute_tool bash` span in CLS marked as an error, with this text as its result.

### 9.2 Whether your environment has a sandbox

It depends on the node's kernel and the container runtime. Tested on 2026-11-11:

| Environment | Landlock | bwrap | Agent runs a command in the container |
|---|---|---|---|
| TKE node (TencentOS Server 4, kernel 6.6, containerd) | Not enabled in the kernel | Containers may not create namespaces by default | Refused, with the error in 9.1 |
| Local Docker (Ubuntu kernel 6.8) | Usable | Not installed in the image | Runs |

The simplest check: change the Job's task in section 6 to ``Use the bash tool to run `echo ok`, then reply with its output only.``, run it once, and see whether the log shows `ok` or the error above.

### 9.3 What to do on TKE

Two ways, depending on your architecture:

1. **Run tools in a remote sandbox** (e2b, Tencent Cloud Agent Runtime, …). DSH's settings stay as they are; the remote environment provides the isolation.
2. **Treat the container itself as the isolation boundary, so DSH adds no second sandbox.** Create `container.patch.yml`:

   ```yaml
   - id: sandbox-policy
     config:
       mode: danger-full-access
   - id: permission
     config:
       defaultPreset: danger-full-access
   ```

   Both entries are needed: the first lets DSH run commands directly; the second makes new sessions start with the same permissions, otherwise headless mode has nobody to approve and commands are still refused. Copy it into the image next to `agentobs.patch.yml` (`COPY agentobs.patch.yml container.patch.yml /opt/dsh-cls-observability/`). For the Job, add `--patch /opt/dsh-cls-observability/container.patch.yml` to `args`, before the task; for the Deployment, add the same `--patch` to the `dsh` container's `args`.

   The agent can then run any command in the container and read the container's environment variables, the CLS and DeepSeek keys included (the plugin masks them before reporting traces, but the agent itself can see them). So: give the CLS sub-account only `cls:UploadLog`; give the container only the permissions and network access it needs; do not mount sensitive directories.

**Do not make the container `privileged` to get a sandbox.** That removes the container's own isolation to gain DSH's inner one, which is worse.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No data in CLS, no `[cls-agentobs]` in the log | The plugin is not loaded | Check that `--patch` comes **before** the task and app arguments such as `--json`; for the Deployment, check that `/data/dsh/cordis.patch.yml` exists |
| You want to see what the plugin does | — | Set `CLS_AGENTOBS_DEBUG=true`; the plugin logs to stderr (visible in `kubectl logs`) |
| Self-test: `CLS_AGENTOBS_ENABLED is not true` | Not set, or misspelled | The value must be the string `"true"` (quoted in YAML) |
| Self-test: `credentials rejected` | Wrong keys or missing permission | Check the Secret and that the sub-account has `cls:UploadLog` on the topic |
| Agent commands are refused with `no sandbox backend is usable` | DSH's command sandbox is unavailable here (DSH's own behavior, unrelated to the plugin) | See section 9 |
| DSH refuses to start the second time, about its credentials file | Each mount makes files group-readable, and DSH refuses an over-permissive credentials file | Add `fsGroupChangePolicy: OnRootMismatch` to the `securityContext` |
| A new pod stays in `ContainerCreating` | The old pod still holds the `ReadWriteOnce` disk | Delete the old Job or pod first; use `strategy: Recreate` for a Deployment |
| After a pod is killed, some data is missing for a while | It is still on the disk | The next pod that mounts the disk takes it over and delivers it within about 2 minutes, on any node |
| Data lost when a pod was killed, with `emptyDir` | `emptyDir` goes with the pod | Use a PVC |
| The web UI asks for authentication (401) | No token, or another program on the local port | Open the full logged address with `?token=`; check the port with `lsof` (section 8) |
| `docker push`: `insufficient_scope` / `unauthorized` | The registry login expired (TCR temporary login commands expire) | Run `docker login` again |
| `ErrImagePull` | No pull credentials for a private registry | Create a `docker-registry` Secret and set `imagePullSecrets` |

---

## 11. Cleanup

```bash
kubectl delete job dsh-task --ignore-not-found
kubectl delete deployment dsh-web --ignore-not-found
kubectl delete pvc dsh-home          # also deletes data on the disk not yet delivered
kubectl delete secret dsh-agentobs
```

---

## Appendix: the files

```
dsh-image/
├── Dockerfile               section 2
└── agentobs.patch.yml       section 2: loads the plugin
pvc.yaml                     section 5
job.yaml                     section 6
deployment.yaml              section 8 (advanced)
```

All settings are in the [README](../README.md#configuration); failure cases and how data is kept are in [reliability.md](reliability.md).
