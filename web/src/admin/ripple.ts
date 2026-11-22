import { readAdminRipplePrefs } from '../shared/adminRipple';

// 仅这些可点击元素参与涟漪；显示端与管理端其他页面不受影响。
const HOST_SELECTOR = [
  '.btn',
  '.chip',
  '.chip .x',
  '.mobile-tab',
  '.settings-tabs button',
  '.remote-btn',
  '[data-ripple]',
].join(',');

const MAX_RIPPLES = 3;

function isAndroidTheme(): boolean {
  return document.body.dataset.theme?.startsWith('android') === true;
}

function addRipple(host: HTMLElement, event: PointerEvent, durationMs: number, opacity: number): void {
  if (host.matches(':disabled, [aria-disabled="true"]')) return;
  const rect = host.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  // 去掉最早的一个，避免长按或快速连点堆积无限节点
  const existing = host.querySelectorAll(':scope > .ssb-ripple');
  if (existing.length >= MAX_RIPPLES) existing[0]?.remove();

  host.classList.add('ssb-ripple-host');

  const size = Math.hypot(rect.width, rect.height) * 2;
  const span = document.createElement('span');
  span.className = 'ssb-ripple';
  span.style.left = `${event.clientX - rect.left}px`;
  span.style.top = `${event.clientY - rect.top}px`;
  span.style.setProperty('--ripple-size', `${size}px`);
  span.style.setProperty('--ripple-duration', `${durationMs}ms`);
  span.style.setProperty('--ripple-opacity', String(opacity));
  span.addEventListener('animationend', () => span.remove(), { once: true });
  host.appendChild(span);
}

/**
 * 全局委托 Android 主题的 M3 涟漪：点击时从触点扩散，结束自动移除。
 * 返回清理函数，便于测试或热更新时卸载。
 */
export function installAndroidRipple(): () => void {
  function onPointerDown(event: PointerEvent): void {
    if (event.defaultPrevented) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!isAndroidTheme()) return;

    const prefs = readAdminRipplePrefs();
    if (!prefs.enabled) return;

    const target = event.target instanceof Element ? event.target : null;
    const host = target?.closest(HOST_SELECTOR);
    if (!(host instanceof HTMLElement)) return;

    addRipple(host, event, prefs.durationMs, prefs.opacity);
  }

  document.addEventListener('pointerdown', onPointerDown, true);
  return () => document.removeEventListener('pointerdown', onPointerDown, true);
}
