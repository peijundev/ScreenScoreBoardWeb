import { useMemo, type JSX } from 'react';
import {
  ADMIN_THEMES,
  normalizeAdminTheme,
  type AdminThemeOption,
} from '../../shared/adminTheme';
import { useAdminTheme } from '../hooks/useAdminTheme';

interface Props {
  wide?: boolean;
}

export default function AdminThemePicker({ wide = false }: Props): JSX.Element {
  const { theme, setTheme } = useAdminTheme();

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
    <label className={'admin-theme-picker' + (wide ? ' mobile-wide' : '')}>
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
}
