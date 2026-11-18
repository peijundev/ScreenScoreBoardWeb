// 管理端通用小工具

export function scoreClass(n: number): string {
  return n > 0 ? 'score-pos' : n < 0 ? 'score-neg' : 'score-zero';
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
  return Array.isArray(presets) && presets.length ? (presets as number[]) : [1, 5, 10, -1];
}
