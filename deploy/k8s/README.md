# Kubernetes 部署（k3s 从零开始）

面向学校内网长期运行的单副本部署。清单默认按 **k3s**（Traefik Ingress + local-path 存储）编写，换 kubeadm / nginx-ingress 只需改 Ingress 类和存储类。

> **单副本是硬约束**：服务端在内存里维护状态并通过 WebSocket 广播，多副本会各自持有一份数据。不要扩容 `replicas`，也不要加 HPA。

## 1. 安装 k3s

单机（最省事，适合一台内网服务器）：

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_MIRROR=cn sh -
```

多节点：第一台按上面的命令安装，其余节点用 token 加入：

```bash
# 在第一台上取 token
sudo cat /var/lib/rancher/k3s/server/node-token

# 在其余节点上
curl -sfL https://get.k3s.io | INSTALL_K3S_MIRROR=cn \
  K3S_URL=https://<第一台IP>:6443 K3S_TOKEN=<token> sh -
```

配置本机 kubectl：

```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown "$USER" ~/.kube/config
kubectl get nodes
```

## 2. 准备镜像

### 方式 A：从 GHCR 拉取（推荐长期使用）

Release 发布会自动推送 `ghcr.io/peijundev/screenscoreboard:<版本>` 和 `:latest`。

首次使用需要在 GitHub 的 Package 设置里把镜像改为 **Public**，否则要创建拉取凭证：

```bash
kubectl -n screenscoreboard create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=<GitHub 用户名> \
  --docker-password=<带 read:packages 的 PAT>
```

然后在 `deployment.yaml` 的 `spec.template.spec` 下加：

```yaml
imagePullSecrets:
  - name: ghcr-pull
```

### 方式 B：本机构建后导入（内网无法访问 GHCR 时）

```bash
docker build -t ghcr.io/peijundev/screenscoreboard:1.6.4 .
docker save ghcr.io/peijundev/screenscoreboard:1.6.4 | sudo k3s ctr images import -

# 或用 Podman
podman save ghcr.io/peijundev/screenscoreboard:1.6.4 | sudo k3s ctr images import -
```

导入后把 `kustomization.yaml` 的 `newTag` 改成对应版本（默认是 `latest`，本地导入时请改成具体版本）。

## 3. 创建命名空间与密码

`ADMIN_PASSWORD` 只在首次启动时生效，之后修改请用 `bin/screenscoreboard-auth.js`。

```bash
kubectl create namespace screenscoreboard --dry-run=client -o yaml | kubectl apply -f -

kubectl -n screenscoreboard create secret generic screenscoreboard-auth \
  --from-literal=ADMIN_PASSWORD='至少 8 位的强密码'
```

使用外部 PostgreSQL / MySQL 时，把连接串也放进同一个 Secret：

```bash
kubectl -n screenscoreboard create secret generic screenscoreboard-auth \
  --from-literal=ADMIN_PASSWORD='...' \
  --from-literal=DATABASE_URL='postgres://user:pass@host:5432/scoreboard'
```

同时把 `configmap.yaml` 的 `STORAGE` 改为 `postgres` 或 `mysql`。

## 4. 修改访问域名

编辑 `ingress.yaml` 里的 `host`（默认 `scoreboard.intranet`），改成内网实际使用的名字，并让 DNS 或客户端 `/etc/hosts` 指向入口节点。

## 5. 部署

```bash
kubectl apply -k deploy/k8s
kubectl -n screenscoreboard rollout status deploy/screenscoreboard
kubectl -n screenscoreboard get pods,svc,ingress,pvc
```

验证：

```bash
# 不配 DNS 时直接带 Host 头访问入口节点
curl -H 'Host: scoreboard.intranet' http://<节点IP>/api/health
```

临时本机访问（不经过 Ingress）：

```bash
kubectl -n screenscoreboard port-forward svc/screenscoreboard 3000:80
# 打开 http://127.0.0.1:3000/admin
```

## 6. 升级

```bash
kubectl -n screenscoreboard set image deploy/screenscoreboard \
  scoreboard=ghcr.io/peijundev/screenscoreboard:1.6.4
kubectl -n screenscoreboard rollout status deploy/screenscoreboard
```

因为使用 `Recreate` 策略，升级期间会有几秒到几十秒不可用，适合活动前操作。

## 7. 备份与恢复

服务会按 `BACKUP_INTERVAL_MINUTES` 把备份写到 `/data/backups`，PVC 里同时有 `state.json`、`auth.json`、头像和音效。

导出：

```bash
kubectl -n screenscoreboard exec deploy/screenscoreboard -- \
  tar czf - -C /data . > screenscoreboard-data-$(date +%F).tar.gz
```

恢复（先停服务，避免内存状态覆盖文件）：

```bash
kubectl -n screenscoreboard scale deploy/screenscoreboard --replicas=0

cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: screenscoreboard-restore
  namespace: screenscoreboard
spec:
  containers:
    - name: restore
      image: alpine:3.20
      command: ["sleep", "3600"]
      volumeMounts:
        - name: data
          mountPath: /data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: screenscoreboard-data
EOF

kubectl -n screenscoreboard cp screenscoreboard-data-2026-11-21.tar.gz \
  screenscoreboard-restore:/data/restore.tar.gz
kubectl -n screenscoreboard exec screenscoreboard-restore -- \
  sh -c 'cd /data && tar xzf restore.tar.gz && rm restore.tar.gz'
kubectl -n screenscoreboard delete pod screenscoreboard-restore
kubectl -n screenscoreboard scale deploy/screenscoreboard --replicas=1
```

## 8. 排错

| 现象 | 原因与处理 |
|---|---|
| `ImagePullBackOff` | GHCR 包仍是私有：改 Public 或按第 2 节创建 `ghcr-pull`；本地导入时确认 tag 与清单一致 |
| Pod `CrashLoopBackOff`，日志是 `EACCES` | PVC 不可写。确认存储类支持 `fsGroup`；`local-path` 默认目录可写，其他存储类可加 initContainer 执行 `chown -R 1000:1000 /data` |
| Pod 一直 `CreateContainerConfigError` | 缺少 `screenscoreboard-auth` Secret |
| Ingress 404 | `host` 与实际访问域名不一致，或集群没有 Traefik（改用 nginx 时把 `ingressClassName` 改成 `nginx`） |
| WebSocket 频繁断开 | 用 nginx-ingress 时加注解 `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` 与 `proxy-send-timeout` |
| 时间不对 | 镜像已装 `tzdata`，确认 ConfigMap 的 `TZ` 生效 |
| 数据丢失 | 确认 PVC 已绑定，且没有把 `replicas` 扩到 1 以上 |

## 9. 卸载

```bash
kubectl delete -k deploy/k8s
# PVC 默认保留；确认不再需要后再删
kubectl -n screenscoreboard delete pvc screenscoreboard-data
kubectl delete namespace screenscoreboard
```
