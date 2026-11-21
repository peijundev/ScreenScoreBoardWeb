# 容器、开发容器与 Kubernetes

本文覆盖运行镜像、Docker / Docker Rootless、Podman、Dev Container 与 Kubernetes。Kubernetes 的完整操作步骤见 [deploy/k8s/README.md](../deploy/k8s/README.md)。

## 镜像

运行镜像基于 **Alpine**（`node:24-alpine`），最终镜像约 200 MB：

- `better-sqlite3` 没有 musl 预编译包，在 `deps` 阶段安装 `python3 make g++ linux-headers` 现场编译，构建工具不会进入最终镜像。
- 运行层只额外安装 `tzdata`（让 `TZ` 生效）与 `ca-certificates`。
- 前端构建阶段使用 `npm ci --ignore-scripts`：既保留 Vite 8 的 rolldown musl 原生绑定，又不下载 Electron、不编译原生模块。
- 容器以非 root 的 `node`（uid 1000）运行，根文件系统在编排配置里是只读的，只有 `/data` 与 `/tmp` 可写。

构建：

```bash
docker build -t screenscoreboard:local .
# 固定 Node 小版本
docker build --build-arg NODE_VERSION=24.22.3 -t screenscoreboard:local .
```

Release 发布会自动推送镜像到 GHCR：

```bash
docker pull ghcr.io/peijundev/screenscoreboard:latest
```

## Docker

```bash
ADMIN_PASSWORD='至少 8 位的强密码' docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3000/api/health
```

- 数据在 `./data`，包含 `state.json`、`auth.json`、头像、音效与 `backups/`。
- 容器根文件系统只读，`/data` 与 `/tmp` 例外；健康检查直接请求 `/api/health`。
- 首次启动必须提供 `ADMIN_PASSWORD`（容器内请求不是 loopback，网页初始化会被拒绝）。
- 使用 PostgreSQL：

  ```bash
  STORAGE=postgres \
  DATABASE_URL='postgres://scoreboard:scoreboard@db:5432/scoreboard' \
  docker compose --profile postgres up -d --build
  ```

`./data` 需要能被 uid 1000 写入。若宿主机用户不是 uid 1000，先执行 `sudo chown -R 1000:1000 data`，或改用[命名卷](#docker-rootless)。

## Docker Rootless

Rootless Docker 把容器内的 uid 1000 映射成宿主机的高位 subuid，直接 bind mount `./data` 时容器用户无法写入。使用附带的命名卷叠加文件：

```bash
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"
docker compose -f docker-compose.yml -f docker-compose.rootless.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.rootless.yml ps
```

- 数据在 Docker 的命名卷 `screenscoreboard-data` 中，用 `docker volume inspect` 查看位置。
- 端口 3000 大于 1024，rootless 下无需额外授权。
- 备份仍可通过 `docker compose exec scoreboard ls /data/backups` 查看。

## Podman

Podman 可以直接构建同一个 Dockerfile：

```bash
podman build -t screenscoreboard:local .
podman run -d --name screenscoreboard -p 3000:3000 \
  -e ADMIN_PASSWORD='至少 8 位的强密码' \
  -v ./data:/data:Z screenscoreboard:local
```

- **SELinux**：bind mount 必须带 `:Z`（或 `:z`），否则容器读不到 `./data`。
- **rootless 权限**：与 Docker Rootless 相同，推荐用命名卷：

  ```bash
  podman compose -f docker-compose.yml -f docker-compose.rootless.yml up -d --build
  ```

- 也可以让 `docker compose` 走 Podman 的兼容 socket：

  ```bash
  systemctl --user enable --now podman.socket
  DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock" docker compose up -d --build
  ```

### Podman Quadlet（长期运行）

`deploy/quadlet/screenscoreboard.container` 是 systemd 用户服务单元，安装步骤写在文件头部注释里。要点：

- `Volume=...:Z,U` 同时处理 SELinux 标签和目录属主。
- `EnvironmentFile` 放 `ADMIN_PASSWORD` 等秘密，权限 600。
- `AutoUpdate=registry` 配合 `podman auto-update` 定时拉取新镜像。
- `loginctl enable-linger "$USER"` 保证未登录时服务仍在运行。

## Dev Container

`.devcontainer/devcontainer.json` 使用 `mcr.microsoft.com/devcontainers/javascript-node:24-bookworm`，打开仓库即可获得 Node 24 开发环境：

- `postCreateCommand` 自动执行 `npm ci`。
- 转发 3000（后端与构建后的前端）与 5173（Vite）。
- 时区固定为 `Asia/Shanghai`。

VS Code / WebStorm 都可以直接识别。基础镜像选 Debian 而不是 Alpine，因为 JetBrains 远程后端依赖 glibc；需要更小的开发镜像时可以自行改成 Alpine，但 IDE 的远程开发功能可能不可用。

在容器里继续玩 Docker / Podman 时，按需把宿主 socket 挂进来，例如 VS Code 的 `docker-outside-of-docker` Feature；Rootless Docker 的 socket 位于 `$XDG_RUNTIME_DIR/docker.sock`，需要自定义 mount。

## Kubernetes

清单在 `deploy/k8s/`，默认按 k3s（Traefik + local-path）编写，包含单副本 Deployment、PVC、ConfigMap、Secret 示例、Service、Ingress 与 Kustomize 入口。完整步骤（安装 k3s、导入镜像、创建密码、升级、备份、排错）见 [deploy/k8s/README.md](../deploy/k8s/README.md)。

## 常见问题

| 问题 | 说明 |
|---|---|
| 镜像多大 | 运行镜像约 200 MB；构建阶段临时安装编译工具，不会留下 |
| 构建慢 | `better-sqlite3` 在 Alpine 上需要现场编译，首次构建约 2–5 分钟；GitHub Actions 使用 `type=gha` 缓存 |
| 时区不对 | 运行镜像已安装 `tzdata`，设置 `TZ=Asia/Shanghai` 即可 |
| 数据目录不可写 | bind mount 需要宿主机目录属主为 uid 1000；否则用命名卷（rootless 叠加文件）或 `chown` |
| WebSocket 断连 | 反向代理需要放行 Upgrade；Traefik 默认支持，nginx-ingress 需要加长 `proxy-read-timeout` |
| 想跑多副本 | 不支持。服务端状态在内存中，多副本会各自维护一份数据；请保持单副本 |
