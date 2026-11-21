# 计分板服务端镜像（仅 Web 服务，不含 Electron）
# 基于 Alpine，运行镜像约 200 MB；可用 --build-arg NODE_VERSION=24.22.3 固定到具体版本
ARG NODE_VERSION=24

# 依赖层：better-sqlite3 没有 musl 预编译包，必须在构建阶段现场编译
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ linux-headers
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 前端（React v2）构建：产出 public/v2
FROM node:${NODE_VERSION}-alpine AS web
WORKDIR /app
# 只构建前端，不需要 Electron 二进制
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
# 不能用 --omit=optional：Vite 8 的 rolldown 原生绑定是可选依赖（Alpine 用 musl 版本）
# 前端构建不需要任何 install 脚本，忽略脚本可避免下载 Electron 与编译 better-sqlite3
RUN npm ci --ignore-scripts && npm cache clean --force
COPY vite.config.mts tsconfig.json ./
COPY web ./web
RUN npm run build:web

# 运行层：只保留运行时需要的包，tzdata 用于 TZ 时区
FROM node:${NODE_VERSION}-alpine
WORKDIR /app
RUN apk add --no-cache tzdata ca-certificates
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY bin ./bin
COPY public ./public
COPY --from=web /app/public/v2 ./public/v2
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
