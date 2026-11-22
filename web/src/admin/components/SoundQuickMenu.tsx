import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '../../shared/types';
import { listAssets, type Asset } from '../../shared/api';
import { SOUND_PRESETS, playPresetSound, playSoundFile } from '../../shared/sound';
import { useAppStore } from '../../shared/store';
import { toast } from '../../shared/ui';

/** 顶部快捷菜单：临时切换当前项目的记分音效，修改立即保存并试听 */
export default function SoundQuickMenu({ project }: { project: Project }): JSX.Element {
  const sendOp = useAppStore((s) => s.sendOp);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const soundEnabled = Boolean(project.settings.soundEnabled);
  const customSound = String(project.settings.customSound || '');
  const preset = String(project.settings.soundPreset || 'default');
  const value = customSound || 'preset:' + preset;
  const volume = Number(project.settings.soundVolume) || 0;

  useEffect(() => {
    if (!open) return;
    listAssets()
      .then((list) => setAssets([...list.sounds].sort((a, b) => b.mtime - a.mtime)))
      .catch(() => setAssets([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeNow(): void {
      setOpen(false);
      setPos(null);
    }
    function onDown(e: PointerEvent): void {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || popRef.current?.contains(target)) return;
      closeNow();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') closeNow();
    }
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', closeNow);
    window.addEventListener('scroll', closeNow, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', closeNow);
      window.removeEventListener('scroll', closeNow, true);
    };
  }, [open]);

  // 弹出层挂到 body：顶栏在 macOS 主题下带 backdrop-filter，会创建层叠上下文，
  // 若留在顶栏内部，z-index 再高也会被后面的对话框整体盖住。
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

  function patchSettings(patch: Record<string, unknown>): void {
    sendOp('updateSettings', { projectId: project.id, patch }).catch((err: Error) => toast(err.message));
  }

  function apply(v: string): void {
    if (v.startsWith('preset:')) {
      const id = v.slice(7);
      patchSettings({ soundPreset: id, customSound: '' });
      playPresetSound(id, 1, volume);
    } else {
      patchSettings({ customSound: v });
      playSoundFile(v, volume);
    }
  }

  return (
    <div className="sound-quick" ref={wrapRef}>
      <button
        ref={buttonRef}
        className="btn small"
        type="button"
        title={customSound ? '当前音效：' + customSound.split('/').pop() : '快捷切换记分音效'}
        aria-expanded={open}
        onClick={toggle}
      >
        音效 ▾
      </button>
      {open && pos && createPortal(
        <div className="sound-quick-pop" ref={popRef} style={{ top: pos.top, right: pos.right }}>
          <label className="check">
            <input
              type="checkbox"
              checked={soundEnabled}
              onChange={(e) => patchSettings({ soundEnabled: e.target.checked })}
            />
            记分音效
          </label>
          <div className="sound-quick-group">
            <span className="sound-quick-title">内置音效</span>
            {SOUND_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={'sound-quick-item' + (value === 'preset:' + p.id ? ' active' : '')}
                onClick={() => apply('preset:' + p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
          {assets.length > 0 && (
            <div className="sound-quick-group">
              <span className="sound-quick-title">已导入音效</span>
              {assets.map((a) => (
                <button
                  key={a.path}
                  type="button"
                  className={'sound-quick-item' + (value === a.path ? ' active' : '')}
                  title={a.path}
                  onClick={() => apply(a.path)}
                >
                  {a.path.split('/').pop()}
                </button>
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
