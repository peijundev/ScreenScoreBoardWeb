import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';

interface Props {
  title: string;
  storageKey: string;
  resizable?: boolean;
  defaultWidth?: number;
  defaultHeight?: number;
  onClose: () => void;
  children: ReactNode;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function readRect(key: string, width: number, height: number): Rect {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Rect>;
      if (Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
        return {
          left: Number(parsed.left),
          top: Number(parsed.top),
          width: Number(parsed.width) || width,
          height: Number(parsed.height) || height,
        };
      }
    }
  } catch {
    // ignore
  }
  return { left: 60, top: 70, width, height };
}

/** 可拖动 / 可缩放的设置窗口（复用旧版 .settings-dialog 样式） */
export default function DialogShell({
  title,
  storageKey,
  resizable = true,
  defaultWidth = 900,
  defaultHeight = 640,
  onClose,
  children,
}: Props): JSX.Element {
  const mobile = useMediaQuery('(max-width: 860px)');
  const [rect, setRect] = useState<Rect>(() =>
    readRect(storageKey + '-rect', Math.min(defaultWidth, window.innerWidth - 40), defaultHeight),
  );
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; start: Rect } | null>(null);

  useEffect(() => {
    // 移动端全屏，不把手机尺寸写进桌面记忆
    if (mobile) return;
    try {
      localStorage.setItem(storageKey + '-rect', JSON.stringify(rect));
    } catch {
      // ignore
    }
  }, [rect, storageKey, mobile]);

  useEffect(() => {
    if (mobile) drag.current = null;
  }, [mobile]);

  useEffect(() => {
    function onMove(e: PointerEvent): void {
      const d = drag.current;
      if (!d || mobile) return;
      if (d.mode === 'move') {
        setRect({ ...d.start, left: d.start.left + e.clientX - d.x, top: d.start.top + e.clientY - d.y });
      } else {
        setRect({
          ...d.start,
          width: Math.max(360, Math.min(window.innerWidth - 20, d.start.width + e.clientX - d.x)),
          height: Math.max(220, Math.min(window.innerHeight - 20, d.start.height + e.clientY - d.y)),
        });
      }
    }
    function onUp(): void {
      drag.current = null;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [mobile]);

  return (
    <div
      className={'settings-dialog' + (mobile ? ' dialog-mobile' : '')}
      style={
        mobile
          ? { display: 'flex', flexDirection: 'column' }
          : {
              display: 'flex',
              flexDirection: 'column',
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
            }
      }
    >
      {resizable && !mobile && (
        <div
          className="dialog-resize-handle"
          title="拖动调整设置窗口大小"
          onPointerDown={(e) => {
            drag.current = { mode: 'resize', x: e.clientX, y: e.clientY, start: rect };
            e.preventDefault();
          }}
        />
      )}
      <header
        className="dialog-header"
        onPointerDown={(e) => {
          if (mobile) return;
          if ((e.target as HTMLElement).closest('button')) return;
          drag.current = { mode: 'move', x: e.clientX, y: e.clientY, start: rect };
          e.preventDefault();
        }}
      >
        <h2>{title}</h2>
        <button className="btn small" type="button" onClick={onClose}>
          关闭
        </button>
      </header>
      <div className="settings-form">{children}</div>
      <datalist id="system-font-list" />
    </div>
  );
}
