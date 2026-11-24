#!/bin/sh
# ScreenScoreBoard 一键部署 / 启动（Linux / macOS）
#
# 功能：
#   1. 检测 Node.js 24+；没有时自动下载官方 Node 24 到项目内 .tools/node（无需 root）。
#   2. npm ci 安装依赖。
#   3. npm run build:web 构建前端。
#   4. 启动服务，打印管理端 / 显示端 / 局域网地址，默认自动打开管理端。
#
# 用法：
#   ./deploy/quickstart.sh
#   ./deploy/quickstart.sh --port 8080 --admin-password 'your-strong-password'
#   ./deploy/quickstart.sh --no-browser --no-build
#
# 可用环境变量：PORT、HOST、DATA_DIR、ADMIN_PASSWORD

set -eu

ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

PORT=${PORT:-3000}
HOST=${HOST:-0.0.0.0}
DATA_DIR=${DATA_DIR:-}
ADMIN_PASSWORD=${ADMIN_PASSWORD:-}
OPEN_BROWSER=1
DO_DEPS=1
DO_BUILD=1
ALLOW_NODE_DOWNLOAD=1

usage() {
  cat <<'EOF'
用法: deploy/quickstart.sh [选项]

  --port <端口>          监听端口（默认 3000）
  --host <地址>          监听地址（默认 0.0.0.0）
  --data-dir <目录>      数据目录（默认 ./data）
  --admin-password <密码> 首次启动时创建管理员（也可用 ADMIN_PASSWORD 环境变量）
  --no-browser           不自动打开管理端
  --no-deps              跳过 npm ci
  --no-build             跳过前端构建
  --no-node-install      不自动下载 Node（系统没有 Node 24+ 时直接报错）
  -h, --help             显示帮助
EOF
}

need_value() {
  if [ "$#" -lt 2 ]; then
    echo "选项 $1 缺少参数" >&2
    usage
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) need_value "$@"; PORT=$2; shift 2 ;;
    --port=*) PORT=${1#*=}; shift ;;
    --host) need_value "$@"; HOST=$2; shift 2 ;;
    --host=*) HOST=${1#*=}; shift ;;
    --data-dir) need_value "$@"; DATA_DIR=$2; shift 2 ;;
    --data-dir=*) DATA_DIR=${1#*=}; shift ;;
    --admin-password) need_value "$@"; ADMIN_PASSWORD=$2; shift 2 ;;
    --admin-password=*) ADMIN_PASSWORD=${1#*=}; shift ;;
    --no-browser) OPEN_BROWSER=0; shift ;;
    --no-deps) DO_DEPS=0; shift ;;
    --no-build) DO_BUILD=0; shift ;;
    --no-node-install) ALLOW_NODE_DOWNLOAD=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知选项: $1" >&2; usage; exit 1 ;;
  esac
done

step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[32m[ok] %s\033[0m\n' "$*"; }
fail() { printf '\033[31m[错误] %s\033[0m\n' "$*" >&2; exit 1; }

case "$PORT" in
  ''|*[!0-9]*) fail "端口必须是数字：$PORT" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  fail "端口必须在 1–65535 之间：$PORT"
fi

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    fail "需要 curl 或 wget 才能下载 Node.js"
  fi
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 20 -o "$2" "$1"
  else
    wget -O "$2" "$1"
  fi
}

node_major() {
  value=$("$1" -v 2>/dev/null || true)
  value=${value#v}
  major=${value%%.*}
  case "$major" in
    ''|*[!0-9]*) echo 0 ;;
    *) echo "$major" ;;
  esac
}

step "检查 Node.js（需要 24+）"
NODE=""
NPM=""
LOCAL_NODE_BIN=""

if command -v node >/dev/null 2>&1; then
  SYS_NODE=$(command -v node)
  if [ "$(node_major "$SYS_NODE")" -ge 24 ]; then
    NODE=$SYS_NODE
    NPM=$(command -v npm || true)
  fi
fi

if [ -z "$NODE" ] && [ -x "$ROOT/.tools/node/bin/node" ]; then
  if [ "$(node_major "$ROOT/.tools/node/bin/node")" -ge 24 ]; then
    NODE="$ROOT/.tools/node/bin/node"
    LOCAL_NODE_BIN="$ROOT/.tools/node/bin"
    NPM="$LOCAL_NODE_BIN/npm"
  fi
fi

if [ -n "$NODE" ]; then
  ok "使用 Node $("$NODE" -v)"
else
  if [ "$ALLOW_NODE_DOWNLOAD" -eq 0 ]; then
    fail "未找到 Node.js 24+；请先安装 Node.js 24，或去掉 --no-node-install。"
  fi

  case "$(uname -s)" in
    Linux) NODE_OS=linux ;;
    Darwin) NODE_OS=darwin ;;
    *) fail "暂不支持当前系统：$(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) fail "暂不支持当前架构：$(uname -m)" ;;
  esac

  step "未找到 Node.js 24+，下载官方 Node 24 到 .tools/node"
  mkdir -p "$ROOT/.tools"
  INDEX_URL="https://nodejs.org/dist/latest-v24.x/"
  SUMS=$(fetch "${INDEX_URL}SHASUMS256.txt") || fail "无法访问 ${INDEX_URL}SHASUMS256.txt"
  LINE=$(printf '%s\n' "$SUMS" | grep -E "node-v[0-9.]+-${NODE_OS}-${NODE_ARCH}\.tar\.gz$" | head -n 1)
  [ -n "$LINE" ] || fail "下载列表中找不到 ${NODE_OS}-${NODE_ARCH} 的 Node 24 包"
  EXPECTED=$(printf '%s\n' "$LINE" | awk '{print $1}')
  FILE=$(printf '%s\n' "$LINE" | awk '{print $2}')
  ARCHIVE="$ROOT/.tools/$FILE"

  step "下载 $FILE"
  download "${INDEX_URL}${FILE}" "$ARCHIVE" || fail "Node.js 下载失败"

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$ROOT/.tools" && printf '%s  %s\n' "$EXPECTED" "$FILE" | sha256sum -c - >/dev/null) \
      || fail "Node.js 安装包 SHA-256 校验失败"
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$ROOT/.tools" && printf '%s  %s\n' "$EXPECTED" "$FILE" | shasum -a 256 -c - >/dev/null) \
      || fail "Node.js 安装包 SHA-256 校验失败"
  else
    echo "[警告] 未找到 sha256sum/shasum，跳过校验" >&2
  fi

  tar -xzf "$ARCHIVE" -C "$ROOT/.tools" || fail "Node.js 解压失败"
  rm -rf "$ROOT/.tools/node"
  mv "$ROOT/.tools/${FILE%.tar.gz}" "$ROOT/.tools/node"
  rm -f "$ARCHIVE"
  NODE="$ROOT/.tools/node/bin/node"
  LOCAL_NODE_BIN="$ROOT/.tools/node/bin"
  NPM="$LOCAL_NODE_BIN/npm"
  ok "Node $("$NODE" -v) 已就绪"
fi

if [ -n "$LOCAL_NODE_BIN" ]; then
  PATH="$LOCAL_NODE_BIN:$PATH"
  export PATH
fi

if [ -z "$NPM" ] || ! command -v "$NPM" >/dev/null 2>&1; then
  fail "未找到 npm，请确认 Node.js 24+ 安装完整。"
fi

if [ "$DO_DEPS" -eq 1 ]; then
  step "安装依赖（npm ci）"
  "$NPM" ci --no-audit --no-fund || fail "npm ci 失败"
  ok "依赖安装完成"
fi

if [ "$DO_BUILD" -eq 1 ]; then
  step "构建前端（npm run build:web）"
  "$NPM" run build:web || fail "前端构建失败"
  ok "前端构建完成"
fi

[ -f "$ROOT/public/v2/display.html" ] || fail "缺少 public/v2/display.html，请先运行 npm run build:web"

if [ -z "$DATA_DIR" ]; then
  DATA_DIR="$ROOT/data"
fi
mkdir -p "$DATA_DIR"
DATA_DIR=$(CDPATH= cd "$DATA_DIR" && pwd)

export PORT HOST DATA_DIR NODE_ENV=production
if [ -n "$ADMIN_PASSWORD" ]; then
  export ADMIN_PASSWORD
fi

ADMIN_URL="http://localhost:${PORT}/admin"
DISPLAY_URL="http://localhost:${PORT}/display"
LAN_IP=""
if command -v hostname >/dev/null 2>&1; then
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
fi
if [ -z "$LAN_IP" ] && command -v ip >/dev/null 2>&1; then
  LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)
fi
if [ -z "$LAN_IP" ] && command -v ipconfig >/dev/null 2>&1; then
  LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || true)
fi

printf '\n'
printf 'ScreenScoreBoard 已准备启动\n'
printf '  管理端：%s\n' "$ADMIN_URL"
printf '  显示端：%s\n' "$DISPLAY_URL"
if [ -n "$LAN_IP" ]; then
  printf '  局域网：http://%s:%s/admin\n' "$LAN_IP" "$PORT"
fi
printf '  数据目录：%s\n' "$DATA_DIR"
if [ -n "$ADMIN_PASSWORD" ]; then
  printf '  已提供 ADMIN_PASSWORD：首次启动会自动创建管理员。\n'
else
  printf '  首次使用：在本机打开管理端创建管理员（网页初始化只接受本机访问）。\n'
fi
printf '  按 Ctrl+C 停止服务。\n\n'

if [ "$OPEN_BROWSER" -eq 1 ]; then
  if command -v xdg-open >/dev/null 2>&1; then
    (sleep 2; xdg-open "$ADMIN_URL" >/dev/null 2>&1 || true) &
  elif command -v open >/dev/null 2>&1; then
    (sleep 2; open "$ADMIN_URL" >/dev/null 2>&1 || true) &
  fi
fi

exec "$NODE" "$ROOT/server/index.js"
