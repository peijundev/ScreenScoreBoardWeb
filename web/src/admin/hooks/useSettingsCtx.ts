import { useCallback, useEffect, useRef } from 'react';
import type { Project } from '../../shared/types';
import { projectOp } from '../../shared/store';
import { toast } from '../../shared/ui';
import type { Ctx } from '../settings/types';
import type { OpName } from '../../shared/ops.generated';

/** 设置面板的单键 patch 上下文：300ms 合并防抖，immediate 立即发送 */
export function useSettingsCtx(project: Project): Ctx {
  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<number | null>(null);

  const flush = useCallback((): void => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length) {
      projectOp(project.id, 'updateSettings', { patch }).catch((err: Error) => toast(err.message));
    }
  }, [project.id]);

  useEffect(() => () => flush(), [flush]);

  const set = useCallback(
    (key: string, value: unknown, immediate?: boolean): void => {
      pending.current[key] = value;
      if (immediate) {
        flush();
        return;
      }
      if (timer.current != null) clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 300);
    },
    [flush],
  );

  const op = useCallback(
    (name: OpName, payload?: Record<string, unknown>): Promise<unknown> =>
      projectOp(project.id, name, payload),
    [project.id],
  );

  return { project, settings: project.settings, set, op };
}
