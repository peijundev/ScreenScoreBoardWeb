import { useMemo, type JSX } from 'react';
import {
  ADMIN_THEMES,
  normalizeAdminTheme,
  type AdminThemeOption,
} from '../../shared/adminTheme';
import { ADMIN_RIPPLE_LIMITS } from '../../shared/adminRipple';
import { useAdminTheme } from '../hooks/useAdminTheme';
import { useAdminRipple } from '../hooks/useAdminRipple';

interface Props {
  wide?: boolean;
}

export default function AdminThemePicker({ wide = false }: Props): JSX.Element {
  const { theme, setTheme } = useAdminTheme();
  const { ripple, updateRipple } = useAdminRipple();
  const android = theme.startsWith('android');

  const groups = useMemo(() => {
    const map = new Map<string, AdminThemeOption[]>();
    for (const item of ADMIN_THEMES) {
      const list = map.get(item.group) || [];
      list.push(item);
      map.set(item.group, list);
    }
    return Array.from(map.entries());
  }, []);

  return (
    <div className={'admin-theme-picker' + (wide ? ' mobile-wide' : '')}>
      <label className="admin-theme-picker-label">
        <span>管理端主题</span>
        <select
          value={theme}
          title="切换管理端主题"
          onChange={(event) => setTheme(normalizeAdminTheme(event.target.value))}
        >
          {groups.map(([group, items]) => (
            <optgroup key={group} label={group}>
              {items.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {android && (
        <details className="android-ripple-panel">
          <summary title="Android 涟漪效果设置">涟漪</summary>
          <div className="android-ripple-body">
            <label className="android-ripple-check">
              <input
                type="checkbox"
                checked={ripple.enabled}
                onChange={(event) => updateRipple({ enabled: event.target.checked })}
              />
              启用点击涟漪
            </label>
            <label className="android-ripple-range">
              <span>时长</span>
              <input
                type="range"
                min={ADMIN_RIPPLE_LIMITS.durationMs.min}
                max={ADMIN_RIPPLE_LIMITS.durationMs.max}
                step={30}
                value={ripple.durationMs}
                disabled={!ripple.enabled}
                onChange={(event) => updateRipple({ durationMs: Number(event.target.value) })}
              />
              <span className="android-ripple-value">{ripple.durationMs} ms</span>
            </label>
            <label className="android-ripple-range">
              <span>强度</span>
              <input
                type="range"
                min={Math.round(ADMIN_RIPPLE_LIMITS.opacity.min * 100)}
                max={Math.round(ADMIN_RIPPLE_LIMITS.opacity.max * 100)}
                step={1}
                value={Math.round(ripple.opacity * 100)}
                disabled={!ripple.enabled}
                onChange={(event) => updateRipple({ opacity: Number(event.target.value) / 100 })}
              />
              <span className="android-ripple-value">{Math.round(ripple.opacity * 100)}%</span>
            </label>
          </div>
        </details>
      )}
    </div>
  );
}
