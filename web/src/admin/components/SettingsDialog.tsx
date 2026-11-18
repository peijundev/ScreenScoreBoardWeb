import type { JSX } from 'react';
import type { Project } from '../../shared/types';
import { SETTINGS_GROUPS } from '../settings/schema';
import FieldControl from '../settings/FieldControl';
import { useSettingsCtx } from '../hooks/useSettingsCtx';
import DialogShell from './DialogShell';

export default function SettingsDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}): JSX.Element {
  const ctx = useSettingsCtx(project);
  return (
    <DialogShell
      title="排版设置"
      storageKey="settingsDialog"
      resizable={project.settings.featureSettingsResize !== false}
      defaultWidth={920}
      defaultHeight={680}
      onClose={onClose}
    >
      {SETTINGS_GROUPS.map((group) => (
        <div className={'set-group' + (group.advanced ? ' advanced' : '')} key={group.title}>
          <h3>{group.title}</h3>
          {group.fields.map((field, index) => (
            <FieldControl key={field.t === 'custom' ? field.id : field.k + ':' + index} field={field} ctx={ctx} />
          ))}
        </div>
      ))}
    </DialogShell>
  );
}
