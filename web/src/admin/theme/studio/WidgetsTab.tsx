import { useEffect, useMemo, useState, type JSX } from 'react';
import type {
  ThemeV2, ThemeWidget, ThemeWidgetSlot, ThemeWidgetSurface, ThemeWidgetType,
} from '../../../shared/theme';

const SURFACES: Array<[ThemeWidgetSurface, string]> = [
  ['canvas', '画布'],
  ['card', '个人卡'],
  ['teamCard', '团队卡'],
  ['memberChip', '成员卡'],
];

const TYPES: Array<[ThemeWidgetType, string]> = [
  ['text', '文本'],
  ['title', '标题'],
  ['score', '分数'],
  ['rank', '名次'],
  ['avatar', '头像'],
  ['image', '图片'],
  ['name', '姓名'],
  ['bio', '简介'],
  ['teamName', '团队名'],
  ['memberCount', '成员数'],
  ['progress', '进度条'],
  ['clock', '时钟'],
  ['countdown', '倒计时'],
];

const SLOTS: Record<ThemeWidgetSurface, Array<[ThemeWidgetSlot, string]>> = {
  canvas: [],
  card: [
    ['rank', '名次'], ['avatar', '头像'], ['name', '姓名'], ['bio', '简介'],
    ['score', '分数'], ['bar', '进度条'], ['extra', '附加元素'],
  ],
  teamCard: [
    ['rank', '名次'], ['avatar', '头像'], ['teamName', '团队名'], ['teamTotal', '团队总分'],
    ['bar', '进度条'], ['extra', '附加元素'],
  ],
  memberChip: [
    ['avatar', '头像'], ['name', '姓名'], ['bio', '简介'], ['score', '分数'], ['extra', '附加元素'],
  ],
};

const BINDS: Array<[string, string]> = [
  ['', '不绑定（固定文本）'],
  ['project.title', '项目标题'],
  ['project.name', '项目名'],
  ['self.name', '当前名称'],
  ['self.score', '当前分数'],
  ['self.bio', '当前简介'],
  ['self.avatar', '当前头像'],
  ['team.name', '团队名'],
  ['team.total', '团队总分'],
  ['rank', '名次'],
  ['memberCount', '成员数'],
  ['countdown.remaining', '倒计时剩余'],
];

function defaultBind(type: ThemeWidgetType): string {
  if (type === 'title') return 'project.title';
  if (type === 'score' || type === 'progress') return 'self.score';
  if (type === 'rank') return 'rank';
  if (type === 'name') return 'self.name';
  if (type === 'bio') return 'self.bio';
  if (type === 'avatar') return 'self.avatar';
  if (type === 'teamName') return 'team.name';
  if (type === 'memberCount') return 'memberCount';
  if (type === 'countdown') return 'countdown.remaining';
  return '';
}

function defaultSlot(surface: ThemeWidgetSurface, type: ThemeWidgetType): ThemeWidgetSlot | undefined {
  if (surface === 'canvas') return undefined;
  if (type === 'name') return 'name';
  if (type === 'bio') return 'bio';
  if (type === 'score' || type === 'progress') return surface === 'teamCard' ? 'teamTotal' : 'score';
  if (type === 'rank') return 'rank';
  if (type === 'avatar') return 'avatar';
  if (type === 'teamName') return 'teamName';
  if (type === 'memberCount') return 'extra';
  if (type === 'text' || type === 'image') return 'extra';
  return 'extra';
}

function newWidget(surface: ThemeWidgetSurface, type: ThemeWidgetType, slot?: ThemeWidgetSlot): ThemeWidget {
  const canvas = surface === 'canvas';
  return {
    id: 'wg_' + Math.random().toString(36).slice(2, 9),
    type,
    surface,
    slot: canvas ? undefined : (slot || defaultSlot(surface, type)),
    x: canvas ? 100 : 0,
    y: canvas ? 100 : 0,
    w: canvas ? 520 : 0,
    h: canvas ? 100 : 0,
    props: {
      text: type === 'text' ? '文字' : '',
      fontSize: 48,
      color: '#ffffff',
      align: 'center',
    },
    bind: { value: defaultBind(type) },
    visible: true,
  };
}

function updateWidget(theme: ThemeV2, id: string, patch: Partial<ThemeWidget>): ThemeV2 {
  return {
    ...theme,
    widgets: theme.widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)),
  };
}

export default function WidgetsTab({
  theme,
  onChange,
}: {
  theme: ThemeV2;
  onChange: (next: ThemeV2) => void;
}): JSX.Element {
  const [surface, setSurface] = useState<ThemeWidgetSurface>('canvas');
  const [type, setType] = useState<ThemeWidgetType>('title');
  const [slot, setSlot] = useState<ThemeWidgetSlot | ''>('');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useMemo(
    () => theme.widgets.filter((w) => w.surface === surface),
    [theme.widgets, surface],
  );
  const widget = list.find((w) => w.id === selected) || list[0] || null;

  useEffect(() => {
    if (selected && !list.some((w) => w.id === selected)) setSelected(null);
  }, [list, selected]);

  const availableSlots = SLOTS[surface];

  function add(): void {
    const w = newWidget(surface, type, slot || undefined);
    onChange({ ...theme, widgets: [...theme.widgets, w] });
    setSelected(w.id);
  }

  function patch(patchValue: Partial<ThemeWidget>): void {
    if (!widget) return;
    onChange(updateWidget(theme, widget.id, patchValue));
  }

  function patchProps(patchValue: Record<string, unknown>): void {
    if (!widget) return;
    patch({ props: { ...widget.props, ...patchValue } });
  }

  function remove(): void {
    if (!widget) return;
    onChange({ ...theme, widgets: theme.widgets.filter((w) => w.id !== widget.id) });
    setSelected(null);
  }

  return (
    <div className="widgets-editor">
      <aside className="vector-side">
        <div className="settings-tabs">
          {SURFACES.map(([value, label]) => (
            <button key={value} type="button" className={surface === value ? 'active' : ''}
              onClick={() => { setSurface(value); setSelected(null); }}>
              {label}
            </button>
          ))}
        </div>
        <div className="vector-layers">
          {list.length === 0 && <p className="hint">这个区域还没有控件。</p>}
          {list.map((w) => (
            <div key={w.id} className={'vector-layer' + (w.id === widget?.id ? ' active' : '')}
              onClick={() => setSelected(w.id)}>
              <span>{TYPES.find(([t]) => t === w.type)?.[1] || w.type}{w.slot ? ' · ' + w.slot : ''}</span>
            </div>
          ))}
        </div>
        <div className="vector-section-head"><strong>添加</strong></div>
        <label className="widget-add-field">类型
          <select value={type} onChange={(e) => setType(e.target.value as ThemeWidgetType)}>
            {TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {availableSlots.length > 0 && (
          <label className="widget-add-field">挂载位置
            <select value={slot} onChange={(e) => setSlot(e.target.value as ThemeWidgetSlot | '')}>
              <option value="">自动</option>
              {availableSlots.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        )}
        <button className="btn small" type="button" onClick={add}>添加控件</button>
      </aside>

      <div className="widgets-preview">
        <p className="hint">
          控件是声明式配置：选择类型、挂载位置和数据绑定，显示端按当前人员/团队/项目数据渲染。
        </p>
        <div className="widgets-demo">
          <div className="widgets-demo-title">{widget ? (TYPES.find(([t]) => t === widget.type)?.[1] || widget.type) : '未选择控件'}</div>
          <div className="widgets-demo-body">
            {widget ? `surface: ${widget.surface}${widget.slot ? ' · slot: ' + widget.slot : ''}` : '从左侧选择或添加一个控件'}
          </div>
        </div>
      </div>

      <aside className="vector-side">
        <div className="vector-section-head"><strong>控件属性</strong></div>
        {widget ? (
          <div className="vector-props">
            <label>类型
              <select value={widget.type} onChange={(e) => patch({ type: e.target.value as ThemeWidgetType })}>
                {TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {availableSlots.length > 0 && (
              <label>挂载位置
                <select value={widget.slot || ''} onChange={(e) => patch({ slot: (e.target.value || undefined) as ThemeWidgetSlot | undefined })}>
                  {availableSlots.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            )}
            {surface === 'canvas' && (
              <>
                <label>X<input type="number" value={widget.x} onChange={(e) => patch({ x: Number(e.target.value) })} /></label>
                <label>Y<input type="number" value={widget.y} onChange={(e) => patch({ y: Number(e.target.value) })} /></label>
                <label>宽<input type="number" min={8} value={widget.w} onChange={(e) => patch({ w: Math.max(8, Number(e.target.value)) })} /></label>
                <label>高<input type="number" min={8} value={widget.h} onChange={(e) => patch({ h: Math.max(8, Number(e.target.value)) })} /></label>
              </>
            )}
            <label>数据绑定
              <select value={String(widget.bind?.value || '')}
                onChange={(e) => patch({ bind: { ...widget.bind, value: e.target.value } })}>
                {BINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>固定文本
              <input value={String(widget.props?.text || '')} onChange={(e) => patchProps({ text: e.target.value })} />
            </label>
            <label>字号
              <input type="number" min={1} value={Number(widget.props?.fontSize || 48)}
                onChange={(e) => patchProps({ fontSize: Number(e.target.value) })} />
            </label>
            <label>颜色
              <input value={String(widget.props?.color || '#ffffff')} onChange={(e) => patchProps({ color: e.target.value })} />
            </label>
            <label>对齐
              <select value={String(widget.props?.align || 'center')} onChange={(e) => patchProps({ align: e.target.value })}>
                <option value="left">左</option><option value="center">中</option><option value="right">右</option>
              </select>
            </label>
            <label>背景
              <input value={String(widget.props?.background || '')} onChange={(e) => patchProps({ background: e.target.value })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={widget.visible !== false} onChange={(e) => patch({ visible: e.target.checked })} />
              显示这个控件
            </label>
            <button className="btn small danger" type="button" onClick={remove}>删除控件</button>
          </div>
        ) : (
          <p className="hint">选择或添加控件后可编辑属性。</p>
        )}
      </aside>
    </div>
  );
}
