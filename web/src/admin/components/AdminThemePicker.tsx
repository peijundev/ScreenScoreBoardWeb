import { useMemo, type JSX } from 'react';
import {
  ADMIN_THEMES,
  normalizeAdminTheme,
  type AdminThemeOption,
} from '../../shared/adminTheme';
import { ADMIN_RIPPLE_LIMITS } from '../../shared/adminRipple';
import { ADMIN_SWITCH_LIMITS } from '../../shared/adminSwitch';
import { useAdminTheme } from '../hooks/useAdminTheme';
import { useAdminRipple } from '../hooks/useAdminRipple';
import { useAdminSwitch } from '../hooks/useAdminSwitch';
import TopbarPopover from './TopbarPopover';

interface Props {
  wide?: boolean;
  /** 内嵌到「外观设置」面板：不产生嵌套弹层，直接把开关 / 涟漪参数平铺。 */
  inline?: boolean;
}

export default function AdminThemePicker({ wide = false, inline = false }: Props): JSX.Element {
  const { theme, setTheme } = useAdminTheme();
  const { ripple, updateRipple } = useAdminRipple();
  const { prefs, updateSwitch } = useAdminSwitch();
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

  const themeField = (
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
  );

  const switchFields = (
    <>
      <label className="admin-switch-check">
        <input
          type="checkbox"
          checked={prefs.enabled}
          onChange={(event) => updateSwitch({ enabled: event.target.checked })}
        />
        苹果风格开关
      </label>
      <label className="admin-switch-range">
        <span>尺寸</span>
        <input
          type="range"
          min={ADMIN_SWITCH_LIMITS.size.min}
          max={ADMIN_SWITCH_LIMITS.size.max}
          step={2}
          value={prefs.size}
          disabled={!prefs.enabled}
          onChange={(event) => updateSwitch({ size: Number(event.target.value) })}
        />
        <span className="admin-switch-value">{prefs.size}px</span>
      </label>
      <label className="admin-switch-range">
        <span>动画</span>
        <input
          type="range"
          min={ADMIN_SWITCH_LIMITS.durationMs.min}
          max={ADMIN_SWITCH_LIMITS.durationMs.max}
          step={20}
          value={prefs.durationMs}
          disabled={!prefs.enabled}
          onChange={(event) => updateSwitch({ durationMs: Number(event.target.value) })}
        />
        <span className="admin-switch-value">{prefs.durationMs}ms</span>
      </label>
    </>
  );

  const rippleFields = android ? (
    <>
      <label className="admin-switch-check">
        <input
          type="checkbox"
          checked={ripple.enabled}
          onChange={(event) => updateRipple({ enabled: event.target.checked })}
        />
        启用点击涟漪
      </label>
      <label className="admin-switch-range">
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
        <span className="admin-switch-value">{ripple.durationMs} ms</span>
      </label>
      <label className="admin-switch-range">
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
        <span className="admin-switch-value">{Math.round(ripple.opacity * 100)}%</span>
      </label>
    </>
  ) : null;

  if (inline) {
    return (
      <div className="admin-theme-picker inline">
        {themeField}
        <section className="admin-theme-subsection">
          <h3>开关外观</h3>
          {switchFields}
        </section>
        {rippleFields && (
          <section className="admin-theme-subsection">
            <h3>Android 涟漪</h3>
            {rippleFields}
          </section>
        )}
      </div>
    );
  }

  return (
    <div className={'admin-theme-picker' + (wide ? ' mobile-wide' : '')}>
      {themeField}
      <TopbarPopover label="界面" title="管理端复选框外观" active={prefs.enabled}>
        {switchFields}
      </TopbarPopover>
      {rippleFields && (
        <TopbarPopover label="涟漪" title="Android 涟漪效果设置" active={ripple.enabled}>
          {rippleFields}
        </TopbarPopover>
      )}
    </div>
  );
}
