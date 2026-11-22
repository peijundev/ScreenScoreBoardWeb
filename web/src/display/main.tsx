import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startConnection } from '../shared/store';

let authRetried = false;

function showAuthError(): void {
  if (document.querySelector('.display-auth-error')) return;
  const notice = document.createElement('div');
  notice.className = 'display-auth-error';
  notice.textContent = '会话失效，请刷新页面';
  document.body.appendChild(notice);
}

/** 显示端匿名只读；如果浏览器残留了过期 Cookie，清掉后匿名重连一次 */
function onAuthLost(): void {
  window.dispatchEvent(new Event('ssb:auth-lost'));
  if (authRetried) {
    showAuthError();
    return;
  }
  authRetried = true;
  void fetch('/api/v1/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
  })
    .catch(() => undefined)
    .finally(() => startConnection({ onAuthLost }));
}

startConnection({ onAuthLost });

// 显示端常驻同一页面；发现服务端前端重新构建后自动刷新，避免一直运行旧代码。
// 管理端预览 iframe 不自行刷新，由外层管理端负责。
const BUILD_CHECK_INTERVAL_MS = 30_000;
let lastBuildId: string | null = null;

async function checkBuild(): Promise<void> {
  if (window.parent !== window) return;
  try {
    const res = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return;
    const info = (await res.json()) as { buildId?: string };
    if (!info || typeof info.buildId !== 'string' || !info.buildId) return;
    if (lastBuildId == null) {
      lastBuildId = info.buildId;
      return;
    }
    if (info.buildId !== lastBuildId && document.visibilityState === 'visible') {
      lastBuildId = info.buildId;
      location.reload();
    }
  } catch {
    // 网络抖动时下次再试
  }
}

void checkBuild();
window.setInterval(() => {
  void checkBuild();
}, BUILD_CHECK_INTERVAL_MS);

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
