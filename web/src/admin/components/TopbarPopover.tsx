import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  label: string;
  title: string;
  active?: boolean;
  /** 点击面板内的按钮后自动关闭（适合动作菜单）。 */
  closeOnSelect?: boolean;
  children: ReactNode;
}

/**
 * 顶栏小面板：触发器在顶栏内，面板通过 portal 挂到 body。
 * macOS 主题的顶栏带 backdrop-filter，会创建层叠上下文；面板若留在顶栏内部，
 * z-index 再高也会被后面的内容或对话框整体盖住。
 */
export default function TopbarPopover({
  label,
  title,
  active = false,
  closeOnSelect = false,
  children,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function close(): void {
      setOpen(false);
      setPos(null);
    }
    function onDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || popRef.current?.contains(target)) return;
      close();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') close();
    }
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  function toggle(): void {
    if (open) {
      setOpen(false);
      setPos(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
    setOpen(true);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={'topbar-popover-trigger' + (active ? ' active' : '')}
        title={title}
        aria-expanded={open}
        onClick={toggle}
      >
        {label}
      </button>
      {open && pos && createPortal(
        <div
          className="topbar-popover"
          ref={popRef}
          style={{ top: pos.top, right: pos.right }}
          onClick={(event) => {
            if (!closeOnSelect) return;
            if ((event.target as HTMLElement).closest('button')) {
              setOpen(false);
              setPos(null);
            }
          }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
