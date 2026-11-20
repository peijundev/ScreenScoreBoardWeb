import { useEffect, useRef, useState, type JSX } from 'react';
import type { Project } from '../../shared/types';
import { listAssets, type Asset } from '../../shared/api';
import { SOUND_PRESETS, playPresetSound, playSoundFile } from '../../shared/sound';
import { useAppStore } from '../../shared/store';
import { toast } from '../../shared/ui';

/** 顶部快捷菜单：临时切换当前项目的记分音效，修改立即保存并试听 */
export default function SoundQuickMenu({ project }: { project: Project }): JSX.Element {
  const sendOp = useAppStore((s) => s.sendOp);
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const wrapRef = useRef<HTMLDivElement | null>(null);

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
    function onDown(e: PointerEvent): void {
      if (!wrapRef.current || !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
        className="btn small"
        type="button"
        title={customSound ? '当前音效：' + customSound.split('/').pop() : '快捷切换记分音效'}
        onClick={() => setOpen((v) => !v)}
      >
        音效 ▾
      </button>
      {open && (
        <div className="sound-quick-pop">
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
        </div>
      )}
    </div>
  );
}
