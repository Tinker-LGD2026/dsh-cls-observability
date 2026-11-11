# 从零开始：在 Kubernetes 上运行 DeepSeek Harness 并上报到 CLS

[English](kubernetes.md)

- 适用版本：DSH `0.2.2-rc.1`，插件 `dsh-cls-observability` `0.1.1`
- 示例环境：腾讯云 TKE（x86_64 节点）+ CLS 上海地域

本教程以一个具体任务为例，从零开始完成全部步骤：做镜像，在本机试跑，在 K8s 上跑一次性任务（Job），到 CLS 里查看结果；进阶部分是长期运行的网页版（Deployment）。

**实测情况（2026-11-11）**：从本教程原文提取 Dockerfile 和 YAML，只替换镜像地址和主题 ID，在 TKE（Kubernetes 1.36，x86_64 节点，`cbs` 云硬盘）上执行：

- 镜像：按第 2 节构建，插件 0.1.1 的 SHA-256 校验通过。
- Job：日志里有模型回答和 `0 left`；CLS 中 1 条 Trace、5 个 Span，没有重复，也没有找不到父节点的 Span，入口类型为 `cli`。
- Deployment：通过 `kubectl port-forward` 在网页版发起任务；CLS 中 1 条 Trace、5 个 Span，入口类型为 `web`。
- 第 9 节的结论在同一集群上单独实测。

TKE 上运行的镜像所带插件为 0.1.0，代码与 0.1.1 相同。

**接入插件只需要四样东西：镜像里的插件文件和一个 patch、环境变量、密钥、一块盘。** 插件不要求改动 DSH 的任何其他设置，包括沙箱和权限。DSH 怎么执行工具，由你自己的 Agent 决定，和插件无关；如果你的 Agent 要在容器里执行命令，见[第 9 节](#9-如果你的-agent-要在容器里执行命令)。

---

## 0. 先弄清楚：要准备哪几样东西

先记住一句话：**插件是 DSH 进程启动时加载的一个文件，Kubernetes 只负责把东西交给 DSH。**

K8s 需要交给 DSH 三样东西：

```
┌──────────────────────── 镜像（你自己构建一次）────────────────────────┐
│  DSH 程序                                                              │
│  插件文件  /opt/dsh-cls-observability/dsh-cls-observability.mjs        │
│  patch     agentobs.patch.yml   告诉 DSH “启动时加载上面那个插件文件”  │
│  包装脚本  entrypoint.sh         DSH 退出后把没发完的数据补发出去       │
└────────────────────────────────────────────────────────────────────────┘
          ▲ 由镜像带进 Pod
┌─────────┴──────────────────────── Pod ────────────────────────────────┐
│   DSH 进程（加载了插件）                                               │
│     ├─ 读取环境变量  ◀── Secret：CLS 密钥、DeepSeek API Key            │
│     │                ◀── 普通配置：地域、主题 ID、开关                 │
│     └─ 读写 /data/dsh ◀── PVC：一块云硬盘，Pod 没了盘还在              │
└───────────────────────────────────────────────────────────────────────┘
          │ 插件把 Trace 发往
          ▼
      CLS Trace 主题（控制台里查看）
```

插件运行在 DSH 进程里：它读取 DSH 的运行事件，把待发送的数据写到 `/data/dsh` 下，再通过 HTTPS 发给 CLS。这些操作都不经过 DSH 给 Agent 工具准备的命令沙箱。

本教程用到的几个概念：

| 概念 | 一句话解释 | 在本教程里的作用 |
|---|---|---|
| 镜像 / Dockerfile | 打包好的运行环境；Dockerfile 是制作镜像的“配方” | 把 DSH、插件文件、patch 文件、包装脚本装在一起 |
| Pod | K8s 里实际运行的最小单位，里面跑一个或几个容器 | DSH 在 Pod 里运行 |
| Job | 让 Pod 执行一次任务，结束后不再重启 | 第 6 节，跑一个一次性任务 |
| Deployment | 让 Pod 一直运行，挂了会自动重建 | 第 8 节，长期运行的网页版 DSH |
| Secret | K8s 专门保存密钥的对象，不用写进镜像或配置文件 | 存 CLS 密钥和 DeepSeek API Key |
| PVC | 向集群申请一块持久化的盘 | 存放 DSH 的数据和插件还没发出去的 Trace |
| patch | DSH 的配置文件片段，用来告诉 DSH 加载什么插件、改什么设置 | 让 DSH 加载插件 |
| 环境变量 | 启动进程时传入的 `名字=值` | 插件的全部配置都通过环境变量传入 |

---

## 1. 准备清单

| 要准备的 | 去哪里拿 | 后面用在哪 |
|---|---|---|
| CLS **Trace 主题 ID** | CLS 控制台创建 Agent 可观测用的 Trace 主题，复制主题 ID | `CLS_AGENTOBS_TOPIC_ID` |
| 主题所在**地域** | 例如 `ap-shanghai` | `CLS_AGENTOBS_REGION` |
| 腾讯云 **SecretId / SecretKey** | 建议新建一个子账号，只授权该主题的 `cls:UploadLog` | Secret |
| **DeepSeek API Key** | DeepSeek 开放平台 | Secret（DSH 调模型要用，和插件无关） |
| **镜像仓库** | 例如腾讯云容器镜像服务（TCR），记下仓库地址 | 推送镜像、K8s 拉取镜像 |
| 本机 **Docker**（带 buildx） | Docker Desktop 或 OrbStack 等 | 构建镜像 |
| 本机 **kubectl**，能连上 TKE 集群 | TKE 控制台下载 kubeconfig | 第 4～11 节 |

检查 kubectl 能连上集群：

```bash
kubectl get nodes
```

能列出节点就说明连上了。

---

## 2. 构建镜像

新建一个目录（比如 `dsh-image/`），在里面放 **2 个文件**。如果你已经有自己的 DSH 镜像，只需要把 2.2 里“插件”和“patch 文件”两段加进你的 Dockerfile（另见 [`examples/container/Dockerfile.snippet`](../examples/container/Dockerfile.snippet)）。

### 2.1 `agentobs.patch.yml`：让 DSH 加载插件

```yaml
- insert:
    - id: cls-agentobs
      name: /opt/dsh-cls-observability/dsh-cls-observability.mjs
```

意思是：在 DSH 里插入一个叫 `cls-agentobs` 的插件，插件文件在 `name` 指定的路径。这个路径要和下面 Dockerfile 里放插件文件的位置一致。插件需要的 DSH 配置只有这一个文件。

### 2.2 `Dockerfile`：制作镜像的配方

```dockerfile
# syntax=docker/dockerfile:1

# ---------- 第 1 段：下载 DSH ----------
# 在你电脑本身的架构上下载，再交给第 2 段（在 Apple 芯片上模拟 x86 时，npm 可能解压不全）。
FROM --platform=$BUILDPLATFORM node:24-bookworm AS fetch
ARG DSH_VERSION=0.2.2-rc.1
RUN mkdir -p /opt/dsh && cd /opt/dsh && echo '{"name":"dsh","private":true}' > package.json \
 && npm_config_cpu=x64 npm_config_os=linux npm_config_libc=glibc npm_config_ignore_scripts=true \
    npm install --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}"

# ---------- 第 2 段：最终镜像 ----------
FROM node:24-bookworm
COPY --from=fetch /opt/dsh /opt/dsh
RUN cd /opt/dsh && npm rebuild
ENV PATH=/opt/dsh/node_modules/.bin:$PATH

# 插件：从 npm 下载，按发布的 SHA-256 校验；顺带取出包里的包装脚本 entrypoint.sh。
ARG AGENTOBS_VERSION=0.1.1
ARG AGENTOBS_SHA256=6d1e7287f7e641b589df953d4d715952fae852eff162653afebbfe5860651796
RUN mkdir -p /opt/dsh-cls-observability && cd /tmp \
 && npm pack "dsh-cls-observability@${AGENTOBS_VERSION}" --silent \
 && tar -xzf "dsh-cls-observability-${AGENTOBS_VERSION}.tgz" \
 && cp package/dist/dsh-cls-observability.mjs package/examples/container/entrypoint.sh /opt/dsh-cls-observability/ \
 && chmod 0755 /opt/dsh-cls-observability/entrypoint.sh \
 && rm -rf package ./*.tgz \
 && echo "${AGENTOBS_SHA256}  /opt/dsh-cls-observability/dsh-cls-observability.mjs" | sha256sum -c -

# patch 文件：让 DSH 加载插件。
COPY agentobs.patch.yml /opt/dsh-cls-observability/

RUN mkdir -p /work && chown 1000:1000 /work
WORKDIR /work

# 包装脚本：先运行你传入的命令（DSH），DSH 退出后把没发完的数据补发出去。
ENTRYPOINT ["/opt/dsh-cls-observability/entrypoint.sh"]
```

逐段说明：

| 段落 | 做了什么 | 为什么 |
|---|---|---|
| 第 1 段 | 用 npm 下载 DSH 0.2.2-rc.1 | DSH 本身就是一个 npm 包。`npm_config_cpu=x64` 表示下载 x86_64 版本，因为 TKE 节点一般是 x86_64；如果你的节点是 ARM，改成 `arm64`（同时把 `--platform` 改成 `linux/arm64`） |
| 第 2 段开头 | 拷贝 DSH，`npm rebuild` 补全安装，把 `dsh` 命令加进 PATH | 之后在容器里直接敲 `dsh` 就能运行 |
| 插件 | 下载插件 npm 包，取出插件文件和 `entrypoint.sh`，然后**校验 SHA-256** | 校验不通过时构建会失败，保证镜像里的插件文件和官方发布的一致。插件就这一个文件，没有其他依赖。换版本时，`AGENTOBS_VERSION` 和 `AGENTOBS_SHA256` 一起改，SHA-256 见 [GitHub Release](https://github.com/Tinker-LGD2026/dsh-cls-observability/releases) 里的 `.sha256` 文件 |
| patch 文件 | 把 2.1 的文件拷进镜像 | 运行 DSH 时用 `--patch` 指向它 |
| ENTRYPOINT | 容器启动时先运行包装脚本，脚本再运行你传入的命令 | 容器的主进程一结束容器就被销毁。包装脚本等 DSH 退出后，把还没发出去的数据补发一次，再让容器结束 |

**镜像里不放任何密钥**，密钥在运行时由 K8s Secret 传入。

### 2.3 构建并推送

以腾讯云容器镜像服务个人版为例（把 `<命名空间>` 换成你自己的）：

```bash
cd dsh-image
docker login ccr.ccs.tencentyun.com
docker buildx build --platform linux/amd64 \
  -t ccr.ccs.tencentyun.com/<命名空间>/dsh-agentobs:0.1.1 \
  --push .
```

- `--platform linux/amd64`：在 Apple 芯片的 Mac 上也能构建出 x86_64 镜像。
- `--push`：构建完成后直接推送到仓库。

构建日志里出现 `/opt/dsh-cls-observability/dsh-cls-observability.mjs: OK`，说明插件文件校验通过。

---

## 3. （建议）先在本机试跑镜像

在 K8s 里排查问题比本机难得多，所以先在本机跑通。

先把配置放进当前终端的环境变量。`read -s` 输入时不显示，也不会留在命令历史里：

```bash
export CLS_AGENTOBS_REGION=ap-shanghai
export CLS_AGENTOBS_TOPIC_ID=<你的 Trace 主题 ID>
read -rs -p 'SecretId: '  TENCENTCLOUD_SECRET_ID  && echo && export TENCENTCLOUD_SECRET_ID
read -rs -p 'SecretKey: ' TENCENTCLOUD_SECRET_KEY && echo && export TENCENTCLOUD_SECRET_KEY
read -rs -p 'DeepSeek API Key: ' DEEPSEEK_API_KEY && echo && export DEEPSEEK_API_KEY
IMG=ccr.ccs.tencentyun.com/<命名空间>/dsh-agentobs:0.1.1
```

`docker run -e 名字` 只写名字、不写值时，会把当前终端里的同名变量传进容器，所以密钥不会出现在命令里。

### 3.1 自检：不写入数据，只检查配置

```bash
docker run --rm --platform linux/amd64 \
  -e CLS_AGENTOBS_ENABLED=true -e CLS_AGENTOBS_REGION -e CLS_AGENTOBS_TOPIC_ID \
  -e TENCENTCLOUD_SECRET_ID -e TENCENTCLOUD_SECRET_KEY \
  --entrypoint node "$IMG" /opt/dsh-cls-observability/dsh-cls-observability.mjs --selftest
```

正常时输出 4 行 `ok`（本机试跑没有设置 `DSH_HOME`，数据目录使用默认的 `~/.dsh`，到 K8s 里会改成盘上的 `/data/dsh`）：

```
ok   configuration: endpoint https://ap-shanghai.cls.tencentcs.com/v1/traces, topic <主题 ID>, credentials from environment
ok   content: captured (truncated at 32000), redaction on
ok   outbox: /root/.dsh/agentobs/outbox writable, 0 files waiting
ok   destination: reachable, credentials and topic accepted (1109 ms)
```

| 哪一行是 FAIL | 原因 |
|---|---|
| `configuration` | 少了某个变量，FAIL 后面会写明缺哪个 |
| `destination: credentials rejected` | SecretId / SecretKey 不对，或者子账号没有 `cls:UploadLog` 权限 |
| `destination: topic or endpoint not found` | 主题 ID 或地域填错了 |
| `destination: not reachable` | 网络不通 |

### 3.2 跑一个真实任务

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

正常时，输出的最后是模型的回答 `tutorial-ok`，紧接着是包装脚本补发的日志：

```
tutorial-ok
[cls-agentobs] flush: delivered 0 files, 0 left in .../agentobs/outbox
```

`0 left` 表示没有遗留数据。`delivered 0` 不是出错，而是数据在 DSH 运行期间就已经发出去了，补发时没有剩下的。

> **最容易踩的坑：参数顺序**。`--profile`、`--patch` 必须写在任务内容和 `--json` 等应用参数**之前**。DSH 从第一个它不认识的参数开始，后面的全部交给应用，写在后面的 `--patch` 会被忽略，插件就不会加载。

---

## 4. 把密钥放进 K8s（Secret）

```bash
cat > secret.env <<'EOF'
TENCENTCLOUD_SECRET_ID=<SecretId>
TENCENTCLOUD_SECRET_KEY=<SecretKey>
DEEPSEEK_API_KEY=<DeepSeek API Key>
EOF
kubectl create secret generic dsh-agentobs --from-env-file=secret.env
rm secret.env
```

文件里每一行会成为 Secret 里的一个键，键名就是等号左边的名字。第 6 节的 YAML 用 `envFrom` 把这三个键整体变成 DSH 的环境变量。

如果镜像仓库是私有的，还要让集群能拉取镜像：

```bash
kubectl create secret docker-registry dsh-image-pull \
  --docker-server=ccr.ccs.tencentyun.com \
  --docker-username=<账号 ID> --docker-password=<镜像仓库密码>
```

---

## 5. 申请一块盘（PVC）

保存为 `pvc.yaml`：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: dsh-home
spec:
  accessModes: [ReadWriteOnce]      # 同一时间只能挂到一个节点上
  storageClassName: cbs             # TKE 云硬盘；最小 10Gi
  resources:
    requests:
      storage: 10Gi
```

```bash
kubectl apply -f pvc.yaml
```

**为什么一定要用盘**：插件把每个 Span 发送前先写到 `$DSH_HOME/agentobs/outbox`。Pod 被杀、被驱逐、所在节点宕机时，还没送达的数据留在盘上，下一个挂上这块盘的 Pod 会接着补发，换到别的节点也一样。换成 `emptyDir` 的话，Pod 一没，这些数据就丢了。详见 [reliability.zh-CN.md](reliability.zh-CN.md)。

---

## 6. 在 K8s 上跑一个一次性任务（Job）

保存为 `job.yaml`，把 `<镜像地址>`、`<Trace 主题 ID>` 换成你的值：

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: dsh-task
spec:
  backoffLimit: 0                     # 失败不重试
  template:
    spec:
      restartPolicy: Never
      terminationGracePeriodSeconds: 60   # 给 DSH 停止 + 补发留出时间
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000                 # 让 1000 号用户能写这块盘
        fsGroupChangePolicy: OnRootMismatch   # DSH 本身需要，见第 10 节
      # imagePullSecrets: [{ name: dsh-image-pull }]   # 私有仓库时取消注释
      containers:
        - name: dsh
          image: <镜像地址>
          args:                       # 交给镜像的 ENTRYPOINT（包装脚本）去运行
            - dsh
            - --profile
            - headless
            - --patch
            - /opt/dsh-cls-observability/agentobs.patch.yml
            - "Reply with the single word: tutorial-ok"
          env:
            - { name: DSH_HOME, value: /data/dsh }                     # DSH 的数据目录 = 盘的挂载点
            - { name: CLS_AGENTOBS_ENABLED, value: "true" }            # 打开插件
            - { name: CLS_AGENTOBS_REGION, value: ap-shanghai }
            - { name: CLS_AGENTOBS_NETWORK, value: internal }          # TKE 与 CLS 同地域时走内网
            - { name: CLS_AGENTOBS_TOPIC_ID, value: <Trace 主题 ID> }
            - { name: CLS_AGENTOBS_ENVIRONMENT, value: tutorial }      # 可选：在 CLS 里按环境筛选
          envFrom:
            - secretRef: { name: dsh-agentobs }                        # 第 4 节的三个密钥
          volumeMounts:
            - { name: dsh-home, mountPath: /data/dsh }
      volumes:
        - name: dsh-home
          persistentVolumeClaim: { claimName: dsh-home }
```

运行并查看日志：

```bash
kubectl apply -f job.yaml
kubectl logs -f job/dsh-task
```

日志末尾和 3.2 一样：模型的回答，然后是 `[cls-agentobs] flush: delivered N files, 0 left`。

一些说明：

- **`CLS_AGENTOBS_NETWORK=internal`**：TKE 集群和 CLS 主题在同一地域时，走腾讯云内网，不经过公网。地域不同就删掉这一行。
- **想先自检一下**：把 `args` 换成 `["node", "/opt/dsh-cls-observability/dsh-cls-observability.mjs", "--selftest"]`，看到 4 行 `ok` 后再换回来。
- **换成你自己的任务**：改最后一个参数即可。任务要让 Agent 在容器里执行命令时，先看第 9 节。
- **再跑一次**：Job 不能重复执行，要先删除再创建：`kubectl delete job dsh-task && kubectl apply -f job.yaml`。
- **同时跑多个任务**：一块 `ReadWriteOnce` 盘同一时间只能给一个节点用，每个并发任务要有自己的 PVC。

---

## 7. 去 CLS 控制台查看

打开 Trace 主题的 Agent 可观测页面，按时间找到刚才的任务。如果设置了 `CLS_AGENTOBS_ENVIRONMENT=tutorial`，可以按环境筛选。

上面这个示例任务，实测在 CLS 中共 5 个 Span：

```
enter_application                  一轮对话的入口：用户输入、最终答复
└─ invoke_agent main               Agent
   └─ react round_1                第 1 步
      ├─ chat deepseek-flash       模型作答：Token、首字耗时、输入输出
      └─ chat deepseek-flash       DSH 在后台生成会话标题（只在第一轮出现，和第 1 步同时进行，所以挂在它下面）
```

Agent 调用工具时，每次调用会多一个 `execute_tool <工具名>` Span，挂在对应的步骤下，带入参、结果和耗时；工具失败时 Span 标为错误，并带上报错原文。Agent 名取自 DSH 的 profile：命令行（headless）显示为 `invoke_agent main`，网页版显示为 `invoke_agent standard`，层级结构相同。

---

## 8. 进阶：长期运行的网页版 DSH（Deployment）

和 Job 相比有三点不同：

1. **不是每次都敲命令**，没有地方加 `--patch`。所以用一个初始化容器，在 DSH 启动前把 `agentobs.patch.yml` 复制成 `$DSH_HOME/cordis.patch.yml`，DSH 每次启动都会自动读取这个文件。
2. **一块盘只能有一个 Pod 在用**：`replicas: 1`，并且用 `strategy: Recreate`（先停旧 Pod，再起新 Pod）。需要多副本时改用 StatefulSet，每个副本一块盘。
3. **可选的补发 sidecar**：和 DSH 共用这块盘，每 5 秒把没发完的数据补发一次。

保存为 `deployment.yaml`：

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
        # ① 启动前放好 patch：DSH 每次启动都读 $DSH_HOME/cordis.patch.yml
        - name: agentobs-patch
          image: <镜像地址>
          command: ["/bin/sh", "-c"]
          args:
            - test -f /data/dsh/cordis.patch.yml || cp /opt/dsh-cls-observability/agentobs.patch.yml /data/dsh/cordis.patch.yml
          volumeMounts:
            - { name: dsh-home, mountPath: /data/dsh }
        # ② 可选：补发 sidecar（需要 Kubernetes 1.29 及以上）。不需要就删掉这一段
        - name: agentobs-relay
          image: <镜像地址>
          restartPolicy: Always
          command: ["node", "/opt/dsh-cls-observability/dsh-cls-observability.mjs", "--relay"]
          env: &agentobs-env
            - { name: DSH_HOME, value: /data/dsh }
            - { name: CLS_AGENTOBS_ENABLED, value: "true" }
            - { name: CLS_AGENTOBS_REGION, value: ap-shanghai }
            - { name: CLS_AGENTOBS_NETWORK, value: internal }
            - { name: CLS_AGENTOBS_TOPIC_ID, value: <Trace 主题 ID> }
            - { name: CLS_AGENTOBS_ENVIRONMENT, value: production }
          envFrom: &agentobs-secret
            - secretRef: { name: dsh-agentobs }
          volumeMounts:
            - { name: dsh-home, mountPath: /data/dsh }
      containers:
        - name: dsh
          image: <镜像地址>
          args: ["dsh", "--profile", "web", "--no-open", "--port", "18080"]
          env: *agentobs-env
          envFrom: *agentobs-secret
          volumeMounts:
            - { name: dsh-home, mountPath: /data/dsh }
      volumes:
        - name: dsh-home
          persistentVolumeClaim: { claimName: dsh-home }
```

`&agentobs-env` 和 `*agentobs-env` 是 YAML 的“定义一次、多处引用”写法，这里让 sidecar 和 DSH 用同一份配置。

```bash
kubectl delete job dsh-task --ignore-not-found   # 先释放盘：一块盘同一时间只能给一个 Pod 用
kubectl apply -f deployment.yaml
kubectl port-forward deploy/dsh-web 18080:18080
```

**浏览器要打开的地址在 DSH 的日志里**。网页版需要访问令牌，直接打开 `http://127.0.0.1:18080` 会提示需要认证：

```bash
kubectl logs deploy/dsh-web -c dsh | grep 'dsh web:'
# dsh web: http://127.0.0.1:18080/?token=<一串令牌>
```

在浏览器里打开这一整行地址（带 `?token=`）。之后浏览器会记住登录状态，不用每次都带令牌。这个令牌相当于网页版的密码，不要发给别人。

> **本机 18080 端口被占用时**（比如你开着其他 ssh 隧道），`port-forward` 可能只绑定了 IPv6，浏览器实际连到的是别的程序，会看到 401 或别的页面。先运行 `lsof -nP -iTCP:18080 -sTCP:LISTEN` 看看有没有别的程序在用。有的话，换一个本地端口，例如 `kubectl port-forward deploy/dsh-web 28080:18080`，再把日志地址里的 `18080` 改成 `28080` 打开。

> DSH 网页版默认只监听 Pod 内部的 `127.0.0.1`，所以本教程用 `kubectl port-forward` 访问。如果要对外提供服务，需要自己在前面加带身份认证的入口，不要直接用 Service 或 Ingress 把它暴露出去。

网页版运行期间，`/data/dsh/agentobs/outbox` 里会一直有 `*.wal.sending-*`（当前的写前日志）和 `open-spans-*`（进行中轮次的记录）两个文件，这是正常的，见 [reliability.zh-CN.md](reliability.zh-CN.md)。

---

## 9. 如果你的 Agent 要在容器里执行命令

**这一节讲的是 DSH 自身的行为，与插件无关：接不接插件都一样。** 只有一种情况需要看：你的 Agent 要在 DSH 所在的容器里**本地**执行命令，比如用 `bash` 工具。下面两种情况可以跳过：

- Agent 不执行本地命令，比如纯对话，或者只调用 API 和 MCP 工具；
- 首脑分离：工具在 e2b、腾讯云 Agent Runtime 等远程沙箱里执行。DSH 的本地沙箱只管 DSH 自己启动的子进程，管不到远程沙箱。

### 9.1 会遇到什么

DSH 默认会先把 Agent 要执行的命令放进一个沙箱，限制它只能写工作目录；在 Linux 上，这个沙箱靠 bwrap 或内核的 Landlock 实现。**两种都用不了时，DSH 拒绝执行命令，不会悄悄放开限制。** 这时工具会报下面的错误：

```
sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host;
refusing to run the command unconfined. ...
```

插件照常工作：这次工具调用在 CLS 中是一个标为错误的 `execute_tool bash` Span，结果字段里就是这段报错原文。

### 9.2 你的环境能不能用沙箱

能不能用，取决于节点的内核和容器运行时。实测结果（2026-11-11）：

| 环境 | Landlock | bwrap | Agent 在容器里执行命令 |
|---|---|---|---|
| TKE 节点（TencentOS Server 4，内核 6.6，containerd） | 内核未启用 | 容器默认不允许创建命名空间 | 被拒绝，报 9.1 的错误 |
| 本机 Docker（Ubuntu 内核 6.8） | 可用 | 镜像里没有安装 | 正常执行 |

最简单的检查方法：把第 6 节 Job 的任务换成 ``Use the bash tool to run `echo ok`, then reply with its output only.``，跑一次，看日志里是 `ok` 还是上面的报错。

### 9.3 在 TKE 上怎么办

两种做法，按你的架构选：

1. **把工具放到远程沙箱执行**（e2b、腾讯云 Agent Runtime 等）。DSH 的设置不用改，沙箱由远程环境提供。
2. **把容器本身当作隔离边界，让 DSH 不再套第二层沙箱。** 新建 `container.patch.yml`：

   ```yaml
   - id: sandbox-policy
     config:
       mode: danger-full-access
   - id: permission
     config:
       defaultPreset: danger-full-access
   ```

   这两项要一起设置：第一项让 DSH 直接执行命令；第二项让新会话默认使用同样的权限，否则 headless 模式下没人审批，命令仍会被拒绝。在 Dockerfile 里把它和 `agentobs.patch.yml` 一起拷进镜像（`COPY agentobs.patch.yml container.patch.yml /opt/dsh-cls-observability/`）。Job 在 `args` 里再加一个 `--patch /opt/dsh-cls-observability/container.patch.yml`，写在任务内容之前；Deployment 在 `dsh` 容器的 `args` 里加同样的 `--patch` 参数。

   这样做之后，Agent 在容器里可以执行任意命令，也能读到容器里的环境变量，包括 CLS 密钥和 DeepSeek Key（插件上报 Trace 前会对这些密钥打码，但 Agent 本身能看到）。所以：CLS 子账号只给 `cls:UploadLog` 权限；容器只给必要的权限和网络访问；不要挂载敏感目录。

**不要为了让沙箱可用而给容器加 `privileged`。** 这等于拆掉容器这层隔离，去换 DSH 内部的那一层，安全性反而更差。

---

## 10. 出问题时按这张表排查

| 现象 | 原因 | 解决 |
|---|---|---|
| CLS 里没有数据，日志里也没有 `[cls-agentobs]` | 插件没有加载 | 检查 `--patch` 是否写在任务内容和 `--json` 等应用参数**之前**；Deployment 要检查 `/data/dsh/cordis.patch.yml` 是否存在 |
| 想看插件到底在做什么 | — | 加环境变量 `CLS_AGENTOBS_DEBUG=true`，插件日志会输出到 stderr（`kubectl logs` 能看到） |
| selftest 显示 `CLS_AGENTOBS_ENABLED is not true` | 没设置或拼错 | 值必须是字符串 `"true"`（YAML 里要加引号） |
| selftest 显示 `credentials rejected` | 密钥错误或权限不足 | 检查 Secret 内容，以及子账号是否有该主题的 `cls:UploadLog` 权限 |
| Agent 的命令被拒绝，报 `no sandbox backend is usable` | DSH 的命令沙箱在这个环境里用不了（DSH 自身的行为，与插件无关） | 见第 9 节 |
| 第二次启动时 DSH 拒绝启动，提示凭证文件权限不对 | K8s 每次挂盘都会把文件改成组可读，DSH 拒绝使用权限过宽的凭证文件 | `securityContext` 里加 `fsGroupChangePolicy: OnRootMismatch` |
| 新 Pod 一直卡在 `ContainerCreating` | 旧 Pod 还占着这块盘（`ReadWriteOnce`） | 先删除旧的 Job 或 Pod；Deployment 用 `strategy: Recreate` |
| Pod 被强制杀掉后，部分数据没有立即出现 | 数据还留在盘上 | 下一个挂上这块盘的 Pod 会在大约 2 分钟内接管并补发，在任何节点上都可以 |
| 用了 `emptyDir`，Pod 被杀后数据丢失 | `emptyDir` 随 Pod 一起删除 | 换成 PVC |
| 打开网页版提示需要认证（401） | 没带令牌，或者本机端口被别的程序占用 | 用日志里带 `?token=` 的完整地址打开；用 `lsof` 检查端口占用，见第 8 节 |
| `docker push` 提示 `insufficient_scope` / `unauthorized` | 镜像仓库的登录已过期（TCR 的临时登录指令有有效期） | 重新运行 `docker login` |
| 镜像拉取失败 `ErrImagePull` | 私有仓库没有拉取凭证 | 创建 `docker-registry` 类型的 Secret，并在 YAML 里设置 `imagePullSecrets` |

---

## 11. 清理

```bash
kubectl delete job dsh-task --ignore-not-found
kubectl delete deployment dsh-web --ignore-not-found
kubectl delete pvc dsh-home          # 盘上还没补发的数据会一起删除
kubectl delete secret dsh-agentobs
```

---

## 附：整套流程的文件清单

```
dsh-image/
├── Dockerfile               第 2 节
└── agentobs.patch.yml       第 2 节：加载插件
pvc.yaml                     第 5 节
job.yaml                     第 6 节
deployment.yaml              第 8 节（进阶）
```

完整的配置项见 [README](../README.zh-CN.md#配置)，故障场景与数据不丢的机制见 [reliability.zh-CN.md](reliability.zh-CN.md)。
