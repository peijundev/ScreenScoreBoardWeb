import { useState, type JSX } from 'react';
import type { Project } from '../../shared/types';
import type { SettingsTab } from '../settings/types';
import { SETTINGS_GROUPS } from '../settings/schema';
import FieldControl from '../settings/FieldControl';
import { useSettingsCtx } from '../hooks/useSettingsCtx';
import DialogShell from './DialogShell';

const TABS: Array<[SettingsTab, string]> = [
  ['layout', '版式'],
  ['appearance', '外观'],
  ['font', '字体'],
  ['effect', '特效'],
];

export default function SettingsDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}): JSX.Element {
  const ctx = useSettingsCtx(project);
  const [tab, setTab] = useState<SettingsTab>('layout');
  const groups = SETTINGS_GROUPS.filter(
    (group) => group.tab === tab && (!group.visible || group.visible(project.settings)),
  );

  return (
    <DialogShell
      title="排版设置"
      storageKey="settingsDialog"
      resizable={project.settings.featureSettingsResize !== false}
      defaultWidth={920}
      defaultHeight={680}
      onClose={onClose}
    >
      <div className="settings-tabs">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={tab === value ? 'active' : ''}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {groups.map((group) => (
        <div className={'set-group' + (group.advanced ? ' advanced' : '')} key={group.title}>
          <h3>{group.title}</h3>
          {group.fields
            .filter((field) => !field.visible || field.visible(project.settings))
            .map((field, index) => (
              <FieldControl
                key={field.t === 'custom' ? field.id : field.k + ':' + index}
                field={field}
                ctx={ctx}
              />
            ))}
        </div>
      ))}
    </DialogShell>
  );
}
