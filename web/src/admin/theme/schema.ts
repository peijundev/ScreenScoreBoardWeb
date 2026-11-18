import type { Group } from '../settings/types';

const FONT_OPTS: Array<[string, string]> = [
  ['system', '系统黑体'],
  ['serif', '宋体 / 衬线'],
  ['kai', '楷体'],
  ['custom', '自定义系统字体'],
];

const FONT_OPTS_AUTO: Array<[string, string]> = [['auto', '跟随全局字体'], ...FONT_OPTS];

/** 主题编辑器可编辑的视觉设置（与服务端 THEME_SETTING_KEYS 对齐） */
export const THEME_GROUPS: Group[] = [
  {
    title: '基调',
    tab: 'appearance',
    fields: [
      { t: 'select', k: 'theme', label: '深浅主题', opts: [['dark', '深色'], ['light', '浅色']] },
      { t: 'color', k: 'accent', label: '强调色' },
      { t: 'colorToggle', k: 'textColor', label: '自定义文字颜色' },
      { t: 'color', k: 'positiveColor', label: '正分颜色' },
      { t: 'color', k: 'negativeColor', label: '负分颜色' },
      { t: 'colorToggle', k: 'rankColor', label: '自定义名次颜色' },
    ],
  },
  {
    title: '标题',
    tab: 'font',
    fields: [
      {
        t: 'select',
        k: 'titleAlign',
        label: '标题对齐',
        opts: [['auto', '跟随风格'], ['center', '居中'], ['left', '居左'], ['right', '居右']],
      },
      {
        t: 'select',
        k: 'titleDecor',
        label: '标题装饰',
        opts: [['auto', '跟随风格'], ['plain', '纯标题（去掉胶囊/竖条）']],
      },
      { t: 'font', k: 'titleFont', ck: 'titleFontCustom', label: '标题字体', customLabel: '标题字体名称' },
      { t: 'range', k: 'titleSize', label: '标题字号', min: 0, max: 120, step: 2, fmt: 'auto', unit: ' px' },
      { t: 'colorToggle', k: 'titleColor', label: '自定义标题颜色' },
      { t: 'check', k: 'showTitleRule', label: '显示标题横线' },
    ],
  },
  {
    title: '字体',
    tab: 'font',
    fields: [
      { t: 'select', k: 'fontFamily', label: '正文字体', opts: FONT_OPTS },
      { t: 'text', k: 'fontFamilyCustom', label: '正文字体名称', max: 60 },
      { t: 'range', k: 'fontScale', label: '字号缩放', min: 0.7, max: 1.5, step: 0.05, fmt: 'x', unit: ' 倍' },
      { t: 'select', k: 'scoreFont', label: '分数数字字体', opts: [['auto', '跟随内置记分牌字体'], ...FONT_OPTS] },
      { t: 'text', k: 'scoreFontCustom', label: '分数字体名称', max: 60 },
      { t: 'select', k: 'clockFont', label: '时钟字体', opts: FONT_OPTS_AUTO },
      { t: 'text', k: 'clockFontCustom', label: '时钟字体名称', max: 60 },
      { t: 'range', k: 'clockFontSize', label: '时钟字号', min: 0, max: 200, step: 2, fmt: 'auto', unit: ' px' },
      { t: 'select', k: 'countdownFont', label: '倒计时字体', opts: FONT_OPTS_AUTO },
      { t: 'text', k: 'countdownFontCustom', label: '倒计时字体名称', max: 60 },
      { t: 'range', k: 'countdownFontSize', label: '倒计时字号', min: 0, max: 300, step: 2, fmt: 'auto', unit: ' px' },
      { t: 'select', k: 'leaderboardFont', label: '排行榜字体', opts: FONT_OPTS_AUTO },
      { t: 'text', k: 'leaderboardFontCustom', label: '排行榜字体名称', max: 60 },
      { t: 'select', k: 'marqueeFont', label: '跑马灯字体', opts: FONT_OPTS_AUTO },
      { t: 'text', k: 'marqueeFontCustom', label: '跑马灯字体名称', max: 60 },
      { t: 'select', k: 'welcomeFont', label: '欢迎幕布字体', opts: FONT_OPTS_AUTO },
      { t: 'text', k: 'welcomeFontCustom', label: '欢迎幕布字体名称', max: 60 },
      { t: 'range', k: 'welcomeFontSize', label: '欢迎文字字号', min: 0, max: 300, step: 4, fmt: 'auto', unit: ' px' },
      { t: 'select', k: 'bioFont', label: '简介字体', opts: FONT_OPTS_AUTO },
      { t: 'text', k: 'bioFontCustom', label: '简介字体名称', max: 60 },
      { t: 'range', k: 'bioSize', label: '简介字号', min: 0, max: 64, step: 1, fmt: 'auto', unit: ' px' },
      { t: 'colorToggle', k: 'bioColor', label: '自定义简介颜色' },
      { t: 'range', k: 'bioOpacity', label: '简介不透明度', min: 0.2, max: 1, step: 0.05, fmt: 'pct', unit: '%' },
      { t: 'check', k: 'bioItalic', label: '简介斜体' },
    ],
  },
  {
    title: '卡片',
    tab: 'appearance',
    fields: [
      {
        t: 'select',
        k: 'cardStyle',
        label: '卡片样式',
        opts: [
          ['solid', '普通'],
          ['glass', '毛玻璃'],
          ['neumorph', '新拟态'],
          ['neon', '霓虹描边'],
          ['gradient', '渐变'],
          ['paper', '纸片'],
        ],
      },
      {
        t: 'select',
        k: 'cardBgMode',
        label: '卡片底色',
        opts: [['auto', '跟随主题'], ['custom', '自定义纯色'], ['translucent', '半透明'], ['acrylic', '亚克力']],
      },
      { t: 'color', k: 'cardBg', label: '底色颜色' },
      { t: 'range', k: 'cardOpacity', label: '卡片不透明度', min: 0.15, max: 1, step: 0.05, fmt: 'pct', unit: '%' },
      { t: 'range', k: 'cardAcrylicBlur', label: '亚克力模糊', min: 0, max: 40, step: 1, fmt: 'num', unit: ' px' },
      { t: 'range', k: 'cardRadius', label: '卡片圆角', min: 0, max: 32, step: 1, fmt: 'num', unit: ' px' },
      { t: 'range', k: 'glassBlur', label: '毛玻璃模糊', min: 0, max: 40, step: 1, fmt: 'num', unit: ' px' },
      { t: 'range', k: 'glassOpacity', label: '毛玻璃透明度', min: 0.15, max: 0.95, step: 0.05, fmt: 'pct', unit: '%' },
      { t: 'range', k: 'cardBorderWidth', label: '卡片边框宽度', min: 0, max: 6, step: 1, fmt: 'num', unit: ' px' },
      { t: 'colorToggle', k: 'cardBorderColor', label: '自定义边框颜色' },
      {
        t: 'select',
        k: 'cardShadow',
        label: '卡片阴影',
        opts: [['auto', '跟随样式'], ['none', '无'], ['soft', '轻'], ['medium', '中'], ['strong', '强']],
      },
      { t: 'range', k: 'teamAccentWidth', label: '团队色条宽度', min: 0, max: 12, step: 1, fmt: 'num', unit: ' px' },
      { t: 'check', k: 'showTeamAccent', label: '显示团队色条' },
      { t: 'colorToggle', k: 'teamAccentColor', label: '自定义团队色条颜色' },
    ],
  },
  {
    title: '背景与头像',
    tab: 'appearance',
    fields: [
      { t: 'colorToggle', k: 'bgColor', label: '自定义背景色' },
      { t: 'check', k: 'bgScrimEnabled', label: '背景遮罩' },
      { t: 'range', k: 'scrimOpacity', label: '遮罩强度', min: 0, max: 1, step: 0.05, fmt: 'pct', unit: '%' },
      { t: 'check', k: 'bgImageBlur', label: '背景图虚化' },
      { t: 'range', k: 'bgImageBlurAmount', label: '虚化度', min: 0, max: 40, step: 1, fmt: 'num', unit: ' px' },
      { t: 'range', k: 'avatarBorderWidth', label: '头像边框宽度', min: 0, max: 6, step: 1, fmt: 'num', unit: ' px' },
      { t: 'select', k: 'avatarShape', label: '头像形状', opts: [['circle', '圆形'], ['square', '方形']] },
    ],
  },
  {
    title: '间距与名次',
    tab: 'appearance',
    fields: [
      { t: 'range', k: 'boardMaxWidth', label: '页面最大宽度', min: 900, max: 2600, step: 20, fmt: 'num', unit: ' px' },
      { t: 'range', k: 'cardGap', label: '卡片间距', min: 0, max: 60, step: 1, fmt: 'auto', unit: ' px' },
      { t: 'range', k: 'cardPad', label: '卡片内边距', min: 0, max: 60, step: 1, fmt: 'auto', unit: ' px' },
      { t: 'range', k: 'memberScale', label: '成员卡片大小', min: 0.6, max: 2, step: 0.05, fmt: 'x', unit: ' 倍' },
      { t: 'range', k: 'rankSize', label: '名次字号', min: 10, max: 40, step: 1, fmt: 'num', unit: ' px' },
      { t: 'range', k: 'scoreBarHeight', label: '比例条高度', min: 0, max: 16, step: 1, fmt: 'num', unit: ' px' },
    ],
  },
  {
    title: '倒计时外观',
    tab: 'appearance',
    fields: [
      {
        t: 'select',
        k: 'countdownTheme',
        label: '倒计时主题',
        opts: [['classic', '经典'], ['ink', '水墨（静态画面）'], ['video', '水墨影片（原片）']],
      },
      {
        t: 'select',
        k: 'countdownShape',
        label: '窗口形状',
        opts: [['circle', '圆形'], ['square', '方形'], ['rounded', '圆角方形'], ['rounded-rect', '圆角矩形'], ['rect', '矩形']],
      },
      { t: 'range', k: 'countdownSize', label: '窗口宽度', min: 200, max: 900, step: 10, fmt: 'num', unit: ' px' },
      { t: 'range', k: 'countdownHeight', label: '窗口高度', min: 0, max: 900, step: 10, fmt: 'auto', unit: ' px' },
      { t: 'range', k: 'countdownRadius', label: '窗口圆角', min: 0, max: 120, step: 2, fmt: 'num', unit: ' px' },
      {
        t: 'select',
        k: 'countdownBgMode',
        label: '窗口背景',
        opts: [['theme', '跟随主题'], ['custom', '自定义颜色'], ['translucent', '半透明'], ['acrylic', '亚克力']],
      },
      { t: 'color', k: 'countdownBg', label: '窗口底色' },
      { t: 'range', k: 'countdownOpacity', label: '窗口不透明度', min: 0.2, max: 1, step: 0.05, fmt: 'pct', unit: '%' },
      { t: 'range', k: 'countdownBlur', label: '亚克力模糊', min: 0, max: 40, step: 1, fmt: 'num', unit: ' px' },
      { t: 'colorToggle', k: 'countdownTextColor', label: '自定义文字颜色' },
    ],
  },
  {
    title: '排行榜 / 跑马灯 / 欢迎',
    tab: 'appearance',
    fields: [
      { t: 'range', k: 'leaderboardScale', label: '排行榜缩放', min: 0.8, max: 1.6, step: 0.05, fmt: 'x', unit: ' 倍' },
      { t: 'range', k: 'marqueeFontSize', label: '跑马灯字号', min: 0, max: 120, step: 2, fmt: 'auto', unit: ' px' },
      { t: 'colorToggle', k: 'marqueeColor', label: '自定义跑马灯文字颜色' },
      { t: 'colorToggle', k: 'marqueeBgColor', label: '自定义跑马灯背景色' },
      { t: 'colorToggle', k: 'welcomeBgColor', label: '自定义欢迎幕布底色' },
    ],
  },
];

export function themeKeys(): string[] {
  const keys = new Set<string>();
  for (const group of THEME_GROUPS) {
    for (const field of group.fields) {
      if (field.t !== 'custom') keys.add(field.k);
    }
  }
  return Array.from(keys);
}

export function themeSettingsOf(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of themeKeys()) {
    if (settings[key] !== undefined) out[key] = settings[key];
  }
  return out;
}
