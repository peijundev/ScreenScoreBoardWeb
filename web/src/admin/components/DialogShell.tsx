import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';

interface Props {
  title: string;
  storageKey: string;
  resizable?: boolean;
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
  onClose: () => void;
  children: ReactNode;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

type DragState =
  | { mode: 'move'; x: number; y: number; start: Rect }
  | { mode: 'resize'; dir: ResizeDir; x: number; y: number; start: Rect };

const RESIZE_DIRS: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const MIN_WIDTH = 360;
const MIN_HEIGHT = 220;
const EDGE = 120;
let topZIndex = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function offsetFor(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return (Math.abs(hash) % 7) * 26;
}

function readRect(
  key: string,
  width: number,
  height: number,
  minWidth: number,
  minHeight: number,
): Rect {
  const viewportWidth = (typeof window !== 'undefined' && window.innerWidth) || 1280;
  const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 800;
  const maxWidth = Math.max(minWidth, viewportWidth - 16);
  const maxHeight = Math.max(minHeight, viewportHeight - 16);
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Rect>;
      if (Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
        const w = clamp(Number(parsed.width) || width, minWidth, maxWidth);
        const h = clamp(Number(parsed.height) || height, minHeight, maxHeight);
        return {
          left: clamp(Number(parsed.left), -(w - EDGE), Math.max(0, viewportWidth - EDGE)),
          top: clamp(Number(parsed.top), 0, Math.max(0, viewportHeight - 40)),
          width: w,
          height: h,
        };
      }
    }
  } catch {
    // ignore
  }
  const offset = offsetFor(key);
  return {
    left: clamp(60 + offset, 0, Math.max(0, viewportWidth - minWidth)),
    top: clamp(70 + offset, 0, Math.max(0, viewportHeight - minHeight)),
    width: Math.max(minWidth, Math.min(width, viewportWidth - 16)),
    height: Math.max(minHeight, Math.min(height, viewportHeight - 16)),
  };
}

/** 可拖动 / 八方向缩放 / 多窗口可同时打开的设置窗口。 */
export default function DialogShell({
  title,
  storageKey,
  resizable = true,
  defaultWidth = 900,
  defaultHeight = 640,
  minWidth = MIN_WIDTH,
  minHeight = MIN_HEIGHT,
  onClose,
  children,
}: Props): JSX.Element {
  const mobile = useMediaQuery('(max-width: 860px)');
  const [rect, setRect] = useState<Rect>(() =>
    readRect(
      storageKey + '-rect',
      Math.min(defaultWidth, window.innerWidth - 40),
      defaultHeight,
      minWidth,
      minHeight,
    ),
  );
  const [maximized, setMaximized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [zIndex, setZIndex] = useState(() => {
    topZIndex += 1;
    return topZIndex;
  });
  const zRef = useRef(zIndex);
  const restoreRef = useRef<Rect | null>(null);
  const drag = useRef<DragState | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<Rect | null>(null);

  function bringToFront(): void {
    if (zRef.current >= topZIndex) return;
    topZIndex += 1;
    zRef.current = topZIndex;
    setZIndex(topZIndex);
  }

  useEffect(() => {
    // 移动端全屏，不把手机尺寸写进桌面记忆；最大化尺寸也不写入。
    if (mobile || maximized) return;
    try {
      localStorage.setItem(storageKey + '-rect', JSON.stringify(rect));
    } catch {
      // ignore
    }
  }, [rect, storageKey, mobile, maximized]);

  useEffect(() => {
    if (mobile) drag.current = null;
  }, [mobile]);

  useEffect(() => {
    function schedule(next: Rect): void {
      pendingRef.current = next;
      if (frameRef.current != null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        if (pendingRef.current) setRect(pendingRef.current);
      });
    }

    function onMove(e: PointerEvent): void {
      const d = drag.current;
      if (!d || mobile) return;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      if (d.mode === 'move') {
        schedule({
          ...d.start,
          left: clamp(d.start.left + e.clientX - d.x, -(d.start.width - EDGE), viewportWidth - EDGE),
          top: clamp(d.start.top + e.clientY - d.y, 0, viewportHeight - 40),
        });
        return;
      }

      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      let left = d.start.left;
      let top = d.start.top;
      let width = d.start.width;
      let height = d.start.height;
      const maxWidth = Math.max(minWidth, viewportWidth - 16);
      const maxHeight = Math.max(minHeight, viewportHeight - 16);

      if (d.dir.includes('e')) width = clamp(d.start.width + dx, minWidth, maxWidth);
      if (d.dir.includes('s')) height = clamp(d.start.height + dy, minHeight, maxHeight);
      if (d.dir.includes('w')) {
        const nextWidth = clamp(
          d.start.width - dx,
          minWidth,
          Math.max(minWidth, d.start.left + d.start.width),
        );
        left = d.start.left + d.start.width - nextWidth;
        width = nextWidth;
      }
      if (d.dir.includes('n')) {
        const nextHeight = clamp(
          d.start.height - dy,
          minHeight,
          Math.max(minHeight, d.start.top + d.start.height),
        );
        top = d.start.top + d.start.height - nextHeight;
        height = nextHeight;
      }

      width = Math.min(width, Math.max(minWidth, viewportWidth - left - 8));
      height = Math.min(height, Math.max(minHeight, viewportHeight - top - 8));
      left = clamp(left, -(width - EDGE), Math.max(0, viewportWidth - EDGE));
      top = clamp(top, 0, Math.max(0, viewportHeight - 40));
      schedule({ left, top, width, height });
    }

    function onUp(): void {
      if (!drag.current && !pendingRef.current) return;
      drag.current = null;
      setDragging(false);
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (pendingRef.current) {
        const next = pendingRef.current;
        pendingRef.current = null;
        setRect(next);
      }
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [mobile, minWidth, minHeight]);

  function startMove(e: ReactPointerEvent<HTMLElement>): void {
    if (mobile || maximized) return;
    if ((e.target as HTMLElement).closest('button')) return;
    bringToFront();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    drag.current = { mode: 'move', x: e.clientX, y: e.clientY, start: rect };
    setDragging(true);
    e.preventDefault();
  }

  function startResize(e: ReactPointerEvent<HTMLElement>, dir: ResizeDir): void {
    if (mobile || maximized) return;
    bringToFront();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    drag.current = { mode: 'resize', dir, x: e.clientX, y: e.clientY, start: rect };
    setDragging(true);
    e.preventDefault();
    e.stopPropagation();
  }

  function toggleMaximize(): void {
    if (mobile) return;
    if (maximized) {
      if (restoreRef.current) setRect(restoreRef.current);
      setMaximized(false);
      return;
    }
    restoreRef.current = rect;
    setRect({
      left: 8,
      top: 8,
      width: Math.max(minWidth, window.innerWidth - 16),
      height: Math.max(minHeight, window.innerHeight - 16),
    });
    setMaximized(true);
  }

  return (
    <div
      className={
        'settings-dialog' +
        (mobile ? ' dialog-mobile' : '') +
        (dragging ? ' dragging' : '') +
        (maximized ? ' dialog-maximized' : '')
      }
      style={
        mobile
          ? { display: 'flex', flexDirection: 'column', zIndex }
          : {
              display: 'flex',
              flexDirection: 'column',
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              zIndex,
            }
      }
      onPointerDown={bringToFront}
    >
      {!mobile && resizable && !maximized && RESIZE_DIRS.map((dir) => (
        <div
          key={dir}
          className={`dialog-resize-handle dialog-resize-${dir}`}
          title="拖动调整窗口大小"
          onPointerDown={(e) => startResize(e, dir)}
        />
      ))}
      <header
        className="dialog-header"
        onPointerDown={startMove}
        onDoubleClick={mobile ? undefined : toggleMaximize}
        title={mobile ? undefined : '拖动标题栏移动；双击最大化 / 还原'}
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
