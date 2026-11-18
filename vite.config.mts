import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// 前端源码在 web/，构建产物落到 public/v2/（由 server/static.js 的 /admin-v2、/display-v2 路由提供）
const root = path.resolve(process.cwd(), 'web');

export default defineConfig(({ command }) => ({
  root,
  // 开发时直接访问 /admin.html；构建后资源以 /v2/ 为前缀，页面由 /admin-v2、/display-v2 提供
  base: command === 'build' ? '/v2/' : '/',
  plugins: [react()],
  build: {
    outDir: path.resolve(process.cwd(), 'public/v2'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        admin: path.resolve(root, 'admin.html'),
        display: path.resolve(root, 'display.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/avatars': 'http://localhost:3000',
      '/sounds': 'http://localhost:3000',
      '/img': 'http://localhost:3000',
      '/media': 'http://localhost:3000',
      '/admin.css': 'http://localhost:3000',
      '/display.css': 'http://localhost:3000',
    },
  },
}));
