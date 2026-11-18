import type { JSX } from 'react';
import type { Project } from '../../shared/types';
import { FEATURE_GROUPS } from '../settings/featuresSchema';
import FieldControl from '../settings/FieldControl';
import { useSettingsCtx } from '../hooks/useSettingsCtx';
import DialogShell from './DialogShell';

export default function FeaturesDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}): JSX.Element {
  const ctx = useSettingsCtx(project);
  return (
    <DialogShell
      title="功能"
      storageKey="featuresDialog"
      defaultWidth={900}
      defaultHeight={700}
      onClose={onClose}
    >
      {FEATURE_GROUPS.map((group) => (
        <div className="set-group" key={group.title}>
          <h3>{group.title}</h3>
          {group.fields.map((field, index) => (
            <FieldControl key={field.t === 'custom' ? field.id : field.k + ':' + index} field={field} ctx={ctx} />
          ))}
        </div>
      ))}
    </DialogShell>
  );
}
