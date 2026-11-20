# 计分板服务端镜像（仅 Web 服务，不含 Electron）
FROM node:24-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 在缺少预编译包时需要本地编译
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 前端（React v2）构建：产出 public/v2
FROM node:24-bookworm-slim AS web
WORKDIR /app
# 只构建前端，不需要 Electron 二进制
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=optional && npm cache clean --force
COPY vite.config.mts tsconfig.json ./
COPY web ./web
RUN npm run build:web

FROM node:24-bookworm-slim
WORKDIR /app
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
