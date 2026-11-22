import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AuthGate from './auth/AuthGate';
import { installAndroidRipple } from './ripple';
import { applyAdminSwitchPrefs, readAdminSwitchPrefs } from '../shared/adminSwitch';

// 首屏先应用开关外观，避免复选框在 React 挂载前闪一下原生样式
applyAdminSwitchPrefs(readAdminSwitchPrefs());
installAndroidRipple();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
