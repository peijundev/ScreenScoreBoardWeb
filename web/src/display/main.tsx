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

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
