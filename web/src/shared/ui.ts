// 管理端通用小工具

export function scoreClass(n: number): string {
  return n > 0 ? 'score-pos' : n < 0 ? 'score-neg' : 'score-zero';
}

/** 分数统一保留 2 位小数，避免 0.1 + 0.2 之类的浮点误差累积。 */
export function roundScore(n: number): number {
  return Math.round(Number(n) * 100) / 100;
}

type ToastListener = (message: string) => void;
const toastListeners = new Set<ToastListener>();

/** 全局提示（由 <Toasts /> 订阅渲染） */
export function toast(message: string): void {
  for (const listener of toastListeners) listener(message);
}

export function subscribeToast(listener: ToastListener): () => void {
  toastListeners.add(listener);
  return () => toastListeners.delete(listener);
}

export function quickPresets(settings: Record<string, unknown>): number[] {
  const presets = settings.quickScorePresets;
  return Array.isArray(presets) && presets.length ? (presets as number[]) : [1, 3, 5, -1];
}
