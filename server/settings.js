'use strict';
// 设置默认值、主题白名单与逐项校验（前后端契约的单一来源）
const {
  OpError, needString, needAvatar, needSoundPath,
  HEX_COLOR, hexOrEmpty, intRange, boolStrict, fontNameOrEmpty, fontChoice,
} = require('./validation');

const DEFAULT_SETTINGS = {
  title: '计分板',
  displayStyle: 'guofeng',  // lecture | ppt | seewo | kde | guofeng | ink | trueage | ...
  columns: 4,
  density: 'comfortable',   // comfortable | compact
  sortBy: 'score',          // score | created | manual
  sortOrder: 'desc',        // desc | asc
  theme: 'dark',            // dark | light
  accent: '#e8a33d',
  showMemberScore: true,
  showTeamTotal: true,
  bgType: 'color',          // color | image
  bgColor: '',              // '' = 跟随主题
  bgImage: null,            // avatars/xxx.png
  bgImageBlur: false,       // 背景图虚化
  bgImageBlurAmount: 12,    // 背景图虚化度 px（0–40）
  bgScrimEnabled: true,     // 背景图遮罩（防止图片干扰文字；浅色主题下即“发白”层）
  cardBg: '',               // '' = 跟随主题
  cardBgMode: 'auto',       // auto | custom | translucent | acrylic
  cardOpacity: 0.55,        // 半透明/亚克力不透明度 0.15–1
  cardAcrylicBlur: 12,      // 亚克力模糊 px（0–40）
  cardRadius: 10,           // 0–32
  showTeamAccent: true,     // 团队卡左侧色条
  teamAccentColor: '',      // '' = 使用强调色
  layoutMode: 'auto',       // auto | free（自由布局：百分比坐标）
  memberScale: 1,           // 成员小卡片缩放 0.6–2
  avatarPosition: 'left',   // left | right | top | bottom（头像相对姓名）
  avatarSizeMode: 'auto',   // auto（随卡片自适应）| manual
  avatarSize: 64,           // 手动头像大小 px（24–160）
  cardStyle: 'solid',       // solid | glass | neumorph | neon | gradient | paper
  glassBlur: 12,            // 毛玻璃模糊强度 px（0–40）
  glassOpacity: 0.55,       // 毛玻璃卡片不透明度（0.15–0.95）
  scoreEffect: 'bounce',    // none | bounce | glow | float | shake | confetti | spotlight
  spotlightScope: 'person', // team（仅团队）| person_team（人物 + 团队）| person（仅人物）
  spotlightWidth: 520,      // 居中突显宽度 px（200–4000）
  spotlightHeight: 0,       // 居中突显高度 px；0 = 自动（0–3000）
  spotlightTheme: 'pop',    // pop | fly | genie | squeeze
  spotlightReturnToOrigin: false, // （兼容）fly 主题开关
  spotlightReturnDuration: 1600,  // fly 主题时长 ms（600–6000）
  spotlightPlayMode: 'queue',     // queue（队列响应）| interrupt（打断）| parallel（并列）
  spotlightParallelMax: 4,        // 并列模式最多同时展示的卡片数 1–6
  spotlightParallelGap: 20,       // 并列模式卡片间距 px（0–120）
  spotlightParallelTransition: 300, // 并列模式加入/退场/重排时长 ms（0–1500）
  spotlightInterruptFade: 150,    // 打断模式旧特效淡出时长 ms（0–1000）
  spotlightTriggerDuration: 0,     // 手动/API 突显总时长 ms；0=跟随突显主题
  spotlightScrimEnabled: true,    // 突显时压暗背景
  spotlightScrimOpacity: 0.45,    // 压暗强度 0–1
  spotlightFontFamily: 'auto',    // auto（跟随卡片）| system | serif | kai | custom
  spotlightFontFamilyCustom: '',  // 自定义字体名（spotlightFontFamily=custom 时生效）
  spotlightSizeMode: 'custom',    // custom（宽度 + 字号 + 头像）| scale（原卡片整体等比放大）
  spotlightAutoScale: false,      // 字号与头像随突显宽度自动缩放（custom 模式）
  spotlightFontScale: 1,          // 突显字号缩放 0.5–8（相对普通卡片）
  spotlightAvatarEnabled: true,   // 突显时显示头像
  spotlightAvatarSizeMode: 'auto', // auto（跟随卡片）| manual
  spotlightAvatarSize: 96,        // 突显头像手动大小 px（24–1024）
  spotlightAvatarPosition: 'auto', // auto（跟随卡片）| left | right | top | bottom
  scoreEffectDuration: 700, // 特效时长 ms（200–3000）
  scoreEffectColor: '',     // '' = 自动（加分绿/减分红）；或 #rrggbb
  scoreEffectOnlyPositive: false, // 仅加分触发特效
  // 主题脚本：默认关闭；脚本运行在不透明源沙箱里，只能返回受限绘制指令
  themeScriptEnabled: false, // 是否允许执行主题脚本
  themeScriptFps: 8,         // 主题脚本刷新率 1–30 fps
  themeScriptTimeoutMs: 120, // 单帧执行超时 20–500 ms
  soundEnabled: false,      // 记分音效
  soundPreset: 'default',   // 内置音效：default | chime | rise | coin | drum | soft
  soundVolume: 0.5,         // 音效音量 0–1
  customSound: '',          // '' = 使用内置音效；否则 sounds/xxx.mp3

  // ---- 高级外观 ----
  fontFamily: 'system',     // system | serif | kai | custom
  fontFamilyCustom: '',     // 自定义系统字体名称（fontFamily=custom 时生效）
  scoreFont: 'auto',        // 分数数字字体：auto | system | serif | kai | custom
  scoreFontCustom: '',      // 分数自定义系统字体名称
  fontScale: 1,             // 姓名/分数/成员字号缩放 0.7–1.5
  titleSize: 0,             // 标题字号 px；0 = 自动
  titleFont: 'auto',        // 标题字体：auto（跟随全局）| system | serif | kai | custom
  titleFontCustom: '',      // 标题自定义系统字体名称（titleFont=custom 时生效）
  titleAlign: 'auto',       // auto（跟随风格）| center | left | right
  titleDecor: 'auto',       // auto（跟随风格）| plain（纯标题，去掉胶囊/竖条）
  styleFreeConfig: false,   // true = 高级外观设置覆盖风格皮肤的固定排版
  titleFree: false,         // 标题自由位置（可在预览中拖动）
  titleX: 50,               // 标题中心 X（视口百分比 0–100）
  titleY: 8,                // 标题中心 Y（视口百分比 0–100）
  titleColor: '',           // '' = 跟随主题
  showTitleRule: true,      // 标题下方短横线
  boardMaxWidth: 1800,      // 卡片区最大宽度 px（900–2600）
  cardGap: 0,               // 卡片间距；0 = 跟随密度
  cardPad: 0,               // 卡片内边距；0 = 跟随密度
  cardBorderWidth: 1,       // 卡片边框宽度 px（0–6）
  cardBorderColor: '',      // '' = 跟随主题
  cardShadow: 'auto',       // auto | none | soft | medium | strong
  teamAccentWidth: 4,       // 团队卡左侧色条宽度 px（0–12）
  avatarBorderWidth: 1,     // 头像边框宽度 px（0–6）
  avatarShape: 'circle',    // circle | square
  textColor: '',            // '' = 跟随主题
  positiveColor: '#6fbf7b', // 正分颜色
  negativeColor: '#e06c75', // 负分颜色
  rankColor: '',            // 名次颜色；'' = 强调色
  scrimOpacity: 1,          // 背景图压暗倍率 0–1
  showRank: true,           // 显示名次角标
  rankSize: 15,             // 名次字号 px（10–40）
  showScoreBar: true,       // 显示分数比例条
  scoreBarHeight: 5,        // 比例条高度 px（0–16）

  // ---- 简介 ----
  featureBio: true,       // 在人员/团队卡片上显示简介
  bioFont: 'auto',        // auto | system | serif | kai | custom
  bioFontCustom: '',      // 简介自定义系统字体名称
  bioSize: 0,             // 简介字号 px；0=自动
  bioColor: '',           // '' = 跟随主题次要文字色
  bioOpacity: 1,          // 简介不透明度 0.2–1
  bioItalic: false,       // 简介斜体

  // ---- 队长 ----
  featureTeamCaptain: true, // 启用队长设置与卡片标签
  teamCaptainLabel: '队长', // 卡片标签文字（1–8 字）
  teamCaptainSizeMode: 'custom', // custom = 固定字号；auto = 跟随姓名大小
  teamCaptainSize: 12,      // 标签字号 px（8–120）
  teamCaptainColor: '',     // 队长突显色（姓名与标签）；'' = 跟随主题强调色
  teamMemberLayout: 'auto', // 团队内成员卡片排列：auto（按宽度换行）| row（横排）| column（竖排）

  // ---- 功能开关 ----
  featureAvatarEdit: true,
  featureSettingsResize: true,
  featureBatchAdd: true,
  featureSearch: true,
  featureQuickScore: true,
  featureTeamScore: true,
  featureSpotlightTrigger: true, // 允许管理端 / API 手动触发起居突显（不加分）
  featureUndo: true,
  featureResetScores: true,
  featureClock: false,
  featureCountdown: false,
  featureLeaderboard: false,
  featureRankTies: false,
  featureExportImport: true,
  featureCsvExport: true,
  featureDataMaintenance: true,

  // ---- 大屏演示 ----
  clockPosition: 'top-right', // top-left | top-right | bottom-left | bottom-right
  clockFont: 'auto',          // 时钟字体：auto | system | serif | kai | custom
  clockFontCustom: '',        // 时钟自定义系统字体名称
  clockFontSize: 0,           // 时钟字号 px；0=自动
  clockFormat: '24',          // '24' | '12'
  clockShowSeconds: true,
  clockShowDate: false,
  countdownDurationSec: 300,  // 1–3600
  countdownDisplayMode: 'corner', // corner | center | fullscreen
  countdownTheme: 'classic',  // classic | ink（水墨）
  countdownShape: 'circle',   // circle | square | rounded | rounded-rect | rect
  countdownRadius: 28,        // 圆角 px（0–120）
  countdownSize: 520,         // 窗口宽度 px（200–900）
  countdownHeight: 0,         // 窗口高度 px（0=与宽度相同，最大 900）
  countdownFontSize: 0,       // 数字字号 px；0=自动
  countdownFont: 'auto',      // 倒计时字体：auto | system | serif | kai | custom
  countdownFontCustom: '',    // 倒计时自定义系统字体名称
  countdownPosition: 'center', // center | top-left | top | top-right | left | right | bottom-left | bottom | bottom-right
  countdownShowProgress: true,
  countdownShowBackdrop: true,
  countdownBg: '',            // '' = 跟随主题
  countdownBgMode: 'theme',   // theme | custom | translucent | acrylic
  countdownOpacity: 1,        // 0.2–1
  countdownBlur: 12,          // 亚克力模糊 px（0–40）
  countdownTextColor: '',     // '' = 跟随主题
  displayView: 'cards',       // cards | leaderboard
  displayResolution: 'auto',  // auto | WxH（如 3840x2160）：显示端按该逻辑分辨率渲染并等比缩放
  displayResolutionScale: 50, // 内容随分辨率放大的强度 0–100（0=不放大，100=完全按分辨率放大）
  leaderboardScope: 'auto',   // auto | people | teams
  leaderboardLimit: 0,        // 0 = 全部
  leaderboardScale: 1,        // 0.8–1.6
  leaderboardFont: 'auto',    // 排行榜字体：auto | system | serif | kai | custom
  leaderboardFontCustom: '',  // 排行榜自定义系统字体名称
  rankTieMode: 'competition', // competition | dense | none

  // ---- 记分效率与动效 ----
  quickScorePresets: [1, 5, 10, -1], // 快捷记分预设
  scoreRolling: true,         // 滚动数字
  sortAnimation: true,        // 排序重排动画（FLIP）
  rankChangeAnimation: true,  // 名次升降动画
  featureMarquee: false,      // 跑马灯横幅
  bgmEnabled: false,          // 背景音乐
  bgmFile: '',                // 背景音乐文件（sounds/xxx）
  bgmVolume: 0.3,             // 背景音乐音量 0–1
  bgmLoop: true,              // 背景音乐循环
  featureBuzzer: false,       // 抢答模式
  featureTeamPk: false,       // 团队 PK
  featureCarousel: false,     // 轮播多屏
  carouselViews: ['cards', 'leaderboard', 'welcome'], // 轮播视图顺序
  carouselIntervalSec: 15,    // 轮播间隔秒
  featureWelcome: false,      // 欢迎幕布
  marqueeText: '',            // 跑马灯文字
  marqueeFontSize: 0,         // 跑马灯字号 px；0=自动
  marqueeFont: 'auto',        // 跑马灯字体：auto | system | serif | kai | custom
  marqueeFontCustom: '',      // 跑马灯自定义系统字体名称
  marqueePosition: 'top',     // top | bottom
  marqueeEffect: 'scroll',    // scroll | blink | none
  marqueeColor: '',           // '' = 跟随强调色
  marqueeBgColor: '',         // '' = 跟随主题
  marqueeSpeed: 1,            // 滚动速度倍率 0.5–3
  welcomeText: '',            // 欢迎幕布文字
  welcomeFont: 'auto',        // 欢迎幕布字体：auto | system | serif | kai | custom
  welcomeFontCustom: '',      // 欢迎幕布自定义系统字体名称
  welcomeFontSize: 0,         // 欢迎幕布字号 px；0=自动
  welcomeImage: '',           // 欢迎幕布背景图
  welcomeBgColor: '',         // 欢迎幕布纯色画板底色（图空时用）
  featureMobileAdmin: true,   // 管理端移动布局（关闭后手机也走桌面布局，作为回滚保险）
  adminTouchTargetSize: 44,   // 管理端最小触控目标边长 px（40–64）
};


// 主题文件允许携带的设置项（视觉相关；不含行为开关、布局坐标、上传资产与人员/团队数据）
const THEME_SETTING_KEYS = new Set([
  // 基调与颜色
  'theme', 'accent', 'textColor', 'positiveColor', 'negativeColor', 'rankColor',
  'cardBorderColor', 'teamAccentColor',
  // 标题
  'titleAlign', 'titleDecor', 'titleFont', 'titleFontCustom', 'titleSize', 'titleColor', 'showTitleRule',
  // 字体
  'fontFamily', 'fontFamilyCustom', 'fontScale', 'scoreFont', 'scoreFontCustom',
  'clockFont', 'clockFontCustom', 'clockFontSize',
  'countdownFont', 'countdownFontCustom', 'countdownFontSize',
  'leaderboardFont', 'leaderboardFontCustom',
  'marqueeFont', 'marqueeFontCustom',
  'welcomeFont', 'welcomeFontCustom', 'welcomeFontSize',
  'bioFont', 'bioFontCustom', 'bioSize', 'bioColor', 'bioOpacity', 'bioItalic',
  // 卡片与间距
  'cardStyle', 'cardBgMode', 'cardBg', 'cardOpacity', 'cardAcrylicBlur', 'cardRadius',
  'glassBlur', 'glassOpacity', 'cardBorderWidth', 'cardShadow',
  'teamAccentWidth', 'showTeamAccent', 'avatarBorderWidth', 'avatarShape',
  'boardMaxWidth', 'cardGap', 'cardPad', 'memberScale', 'rankSize', 'scoreBarHeight',
  // 背景（不含上传的背景图本身）
  'bgColor', 'bgScrimEnabled', 'scrimOpacity', 'bgImageBlur', 'bgImageBlurAmount',
  // 倒计时窗口外观
  'countdownTheme', 'countdownShape', 'countdownSize', 'countdownHeight', 'countdownRadius',
  'countdownBg', 'countdownBgMode', 'countdownOpacity', 'countdownBlur', 'countdownTextColor',
  // 排行榜 / 跑马灯 / 欢迎幕布
  'leaderboardScale', 'marqueeFontSize', 'marqueeColor', 'marqueeBgColor', 'welcomeBgColor',
]);

const SETTINGS_VALIDATORS = {
  title: (v) => needString(v, '标题', 30),
  displayStyle: (v) =>
    (['lecture', 'ppt', 'seewo', 'kde', 'custom',
      'guofeng', 'ink', 'trueage', 'modern', 'neon', 'poster'].includes(v)
      ? v
      : (() => { throw new OpError('显示风格非法'); })()),
  columns: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 8) throw new OpError('列数须为 1–8 的整数');
    return n;
  },
  density: (v) => (['comfortable', 'compact'].includes(v) ? v : (() => { throw new OpError('密度取值非法'); })()),
  sortBy: (v) => (['score', 'created', 'manual'].includes(v) ? v : (() => { throw new OpError('排序方式非法'); })()),
  sortOrder: (v) => (['desc', 'asc'].includes(v) ? v : (() => { throw new OpError('排序方向非法'); })()),
  theme: (v) => (['dark', 'light'].includes(v) ? v : (() => { throw new OpError('主题取值非法'); })()),
  accent: (v) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v : (() => { throw new OpError('强调色须为 #rrggbb'); })()),
  showMemberScore: (v) => Boolean(v),
  showTeamTotal: (v) => Boolean(v),
  bgType: (v) => (['color', 'image'].includes(v) ? v : (() => { throw new OpError('背景类型非法'); })()),
  bgColor: (v) => {
    if (v === '' || v == null) return '';
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : (() => { throw new OpError('背景色须为 #rrggbb 或留空'); })();
  },
  bgImage: (v) => needAvatar(v === '' ? null : v),
  bgImageBlur: (v) => boolStrict(v, '背景图虚化开关'),
  bgImageBlurAmount: (v) => intRange(v, 0, 40, '背景图虚化度须为 0–40 px'),
  bgScrimEnabled: (v) => boolStrict(v, '背景遮罩开关'),
  cardBg: (v) => {
    if (v === '' || v == null) return '';
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : (() => { throw new OpError('卡片底色须为 #rrggbb 或留空'); })();
  },
  cardBgMode: (v) =>
    (['auto', 'custom', 'translucent', 'acrylic'].includes(v)
      ? v
      : (() => { throw new OpError('卡片底色模式非法'); })()),
  cardOpacity: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.15 || n > 1) throw new OpError('卡片不透明度须在 0.15–1 之间');
    return Math.round(n * 100) / 100;
  },
  cardAcrylicBlur: (v) => intRange(v, 0, 40, '亚克力模糊须为 0–40'),
  showTeamAccent: (v) => Boolean(v),
  teamAccentColor: (v) => hexOrEmpty(v, '团队色条颜色须为 #rrggbb 或留空'),
  cardRadius: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 32) throw new OpError('圆角须为 0–32 的整数');
    return n;
  },
  layoutMode: (v) => (['auto', 'free'].includes(v) ? v : (() => { throw new OpError('布局模式非法'); })()),
  memberScale: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.6 || n > 2) throw new OpError('成员卡片大小须在 0.6–2 之间');
    return Math.round(n * 100) / 100;
  },
  avatarPosition: (v) =>
    (['left', 'right', 'top', 'bottom'].includes(v)
      ? v
      : (() => { throw new OpError('头像位置非法'); })()),
  avatarSizeMode: (v) =>
    (['auto', 'manual'].includes(v) ? v : (() => { throw new OpError('头像大小模式非法'); })()),
  avatarSize: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 24 || n > 160) throw new OpError('头像大小须为 24–160 的整数');
    return n;
  },
  cardStyle: (v) =>
    (['solid', 'glass', 'neumorph', 'neon', 'gradient', 'paper'].includes(v)
      ? v
      : (() => { throw new OpError('卡片样式非法'); })()),
  glassBlur: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 40) throw new OpError('毛玻璃模糊强度须为 0–40 的整数');
    return n;
  },
  glassOpacity: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.15 || n > 0.95) throw new OpError('卡片透明度须在 0.15–0.95 之间');
    return Math.round(n * 100) / 100;
  },
  scoreEffect: (v) =>
    (['none', 'bounce', 'glow', 'float', 'shake', 'confetti', 'spotlight', 'highlight'].includes(v)
      ? v
      : (() => { throw new OpError('加分特效类型非法'); })()),
  spotlightScope: (v) =>
    (['team', 'person_team', 'person'].includes(v)
      ? v
      : (() => { throw new OpError('突显范围非法'); })()),
  spotlightWidth: (v) => intRange(v, 200, 4000, '突显宽度须为 200–4000'),
  spotlightHeight: (v) => intRange(v, 0, 3000, '突显高度须为 0–3000（0=自动）'),
  spotlightReturnToOrigin: (v) => boolStrict(v, '从哪来回哪去开关'),
  spotlightReturnDuration: (v) => intRange(v, 600, 6000, '飞入飞回时长须为 600–6000 ms'),
  spotlightScrimEnabled: (v) => boolStrict(v, '突显压暗开关'),
  spotlightScrimOpacity: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new OpError('突显压暗强度须在 0–1 之间');
    return Math.round(n * 100) / 100;
  },
  spotlightTheme: (v) =>
    (['pop', 'fly', 'genie', 'squeeze'].includes(v)
      ? v
      : (() => { throw new OpError('突显主题非法'); })()),
  spotlightPlayMode: (v) =>
    (['queue', 'interrupt', 'parallel'].includes(v)
      ? v
      : (() => { throw new OpError('播放模式非法'); })()),
  spotlightParallelMax: (v) => intRange(v, 1, 6, '并列最多卡片数须为 1–6'),
  spotlightParallelGap: (v) => intRange(v, 0, 120, '并列卡片间距须为 0–120'),
  spotlightParallelTransition: (v) => intRange(v, 0, 1500, '并列卡片过渡时长须为 0–1500 ms'),
  spotlightInterruptFade: (v) => intRange(v, 0, 1000, '打断淡出时长须为 0–1000 ms'),
  spotlightTriggerDuration: (v) => intRange(v, 0, 10000, '手动突显时长须为 0–10000 ms（0=跟随主题）'),
  spotlightFontFamily: (v) =>
    (['auto', 'system', 'serif', 'kai', 'custom'].includes(v)
      ? v
      : (() => { throw new OpError('突显字体选择非法'); })()),
  spotlightFontFamilyCustom: fontNameOrEmpty,
  spotlightSizeMode: (v) =>
    (['custom', 'scale'].includes(v)
      ? v
      : (() => { throw new OpError('突显尺寸模式须为 custom 或 scale'); })()),
  spotlightAutoScale: (v) => boolStrict(v, '突显自动缩放开关'),
  spotlightFontScale: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.5 || n > 8) throw new OpError('突显字号缩放须在 0.5–8 之间');
    return Math.round(n * 100) / 100;
  },
  spotlightAvatarEnabled: (v) => boolStrict(v, '突显头像开关'),
  spotlightAvatarSizeMode: (v) =>
    (['auto', 'manual'].includes(v)
      ? v
      : (() => { throw new OpError('突显头像大小模式非法'); })()),
  spotlightAvatarSize: (v) => intRange(v, 24, 1024, '突显头像大小须为 24–1024'),
  spotlightAvatarPosition: (v) =>
    (['auto', 'left', 'right', 'top', 'bottom'].includes(v)
      ? v
      : (() => { throw new OpError('突显头像位置非法'); })()),
  scoreEffectDuration: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 200 || n > 3000) throw new OpError('特效时长须为 200–3000 的整数');
    return n;
  },
  scoreEffectColor: (v) => {
    if (v === '' || v == null) return '';
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : (() => { throw new OpError('特效颜色须为 #rrggbb 或留空'); })();
  },
  scoreEffectOnlyPositive: (v) => Boolean(v),
  themeScriptEnabled: (v) => boolStrict(v, '主题脚本开关'),
  themeScriptFps: (v) => intRange(v, 1, 30, '主题脚本帧率须为 1–30'),
  themeScriptTimeoutMs: (v) => intRange(v, 20, 500, '主题脚本单帧超时须为 20–500 ms'),
  soundEnabled: (v) => Boolean(v),
  soundPreset: (v) =>
    (['default', 'chime', 'rise', 'coin', 'drum', 'soft'].includes(v)
      ? v
      : (() => { throw new OpError('内置音效非法'); })()),
  soundVolume: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new OpError('音效音量须在 0–1 之间');
    return Math.round(n * 100) / 100;
  },
  customSound: (v) => needSoundPath(v),

  // ---- 高级外观 ----
  fontFamily: (v) =>
    (['system', 'serif', 'kai', 'custom'].includes(v)
      ? v
      : (() => { throw new OpError('字体选择非法'); })()),
  fontFamilyCustom: fontNameOrEmpty,
  scoreFont: fontChoice('分数字体'),
  scoreFontCustom: fontNameOrEmpty,
  fontScale: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.7 || n > 1.5) throw new OpError('字号缩放须在 0.7–1.5 之间');
    return Math.round(n * 100) / 100;
  },
  titleSize: (v) => intRange(v, 0, 120, '标题字号须为 0–120 的整数（0=自动）'),
  titleFont: (v) =>
    (['auto', 'system', 'serif', 'kai', 'custom'].includes(v)
      ? v
      : (() => { throw new OpError('标题字体非法'); })()),
  titleFontCustom: fontNameOrEmpty,
  titleAlign: (v) =>
    (['auto', 'center', 'left', 'right'].includes(v) ? v : (() => { throw new OpError('标题对齐非法'); })()),
  titleDecor: (v) =>
    (['auto', 'plain'].includes(v) ? v : (() => { throw new OpError('标题装饰取值非法'); })()),
  styleFreeConfig: (v) => Boolean(v),
  titleFree: (v) => Boolean(v),
  titleX: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new OpError('标题位置 X 须在 0–100 之间');
    return Math.round(n * 100) / 100;
  },
  titleY: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new OpError('标题位置 Y 须在 0–100 之间');
    return Math.round(n * 100) / 100;
  },
  titleColor: (v) => hexOrEmpty(v, '标题颜色须为 #rrggbb 或留空'),
  showTitleRule: (v) => Boolean(v),
  boardMaxWidth: (v) => intRange(v, 900, 2600, '页面最大宽度须为 900–2600'),
  cardGap: (v) => intRange(v, 0, 60, '卡片间距须为 0–60'),
  cardPad: (v) => intRange(v, 0, 60, '卡片内边距须为 0–60'),
  cardBorderWidth: (v) => intRange(v, 0, 6, '卡片边框宽度须为 0–6'),
  cardBorderColor: (v) => hexOrEmpty(v, '卡片边框颜色须为 #rrggbb 或留空'),
  cardShadow: (v) =>
    (['auto', 'none', 'soft', 'medium', 'strong'].includes(v)
      ? v
      : (() => { throw new OpError('卡片阴影取值非法'); })()),
  teamAccentWidth: (v) => intRange(v, 0, 12, '团队色条宽度须为 0–12'),
  avatarBorderWidth: (v) => intRange(v, 0, 6, '头像边框宽度须为 0–6'),
  avatarShape: (v) =>
    (['circle', 'square'].includes(v) ? v : (() => { throw new OpError('头像形状非法'); })()),
  textColor: (v) => hexOrEmpty(v, '文字颜色须为 #rrggbb 或留空'),
  positiveColor: (v) => (HEX_COLOR.test(v) ? v : (() => { throw new OpError('正分颜色须为 #rrggbb'); })()),
  negativeColor: (v) => (HEX_COLOR.test(v) ? v : (() => { throw new OpError('负分颜色须为 #rrggbb'); })()),
  rankColor: (v) => hexOrEmpty(v, '名次颜色须为 #rrggbb 或留空'),
  scrimOpacity: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new OpError('背景遮罩强度须在 0–1 之间');
    return Math.round(n * 100) / 100;
  },
  showRank: (v) => Boolean(v),
  rankSize: (v) => intRange(v, 10, 40, '名次字号须为 10–40'),
  showScoreBar: (v) => Boolean(v),
  scoreBarHeight: (v) => intRange(v, 0, 16, '比例条高度须为 0–16'),

  // ---- 简介 ----
  featureBio: (v) => boolStrict(v, '简介开关'),
  bioFont: fontChoice('简介字体'),
  bioFontCustom: fontNameOrEmpty,
  bioSize: (v) => intRange(v, 0, 64, '简介字号须为 0–64（0=自动）'),
  bioColor: (v) => hexOrEmpty(v, '简介颜色须为 #rrggbb 或留空'),
  bioOpacity: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.2 || n > 1) throw new OpError('简介不透明度须在 0.2–1 之间');
    return Math.round(n * 100) / 100;
  },
  bioItalic: (v) => boolStrict(v, '简介斜体开关'),

  // ---- 队长 ----
  featureTeamCaptain: (v) => boolStrict(v, '队长开关'),
  teamCaptainLabel: (v) => needString(v, '队长标签', 8),
  teamCaptainSizeMode: (v) => {
    if (v !== 'auto' && v !== 'custom') throw new OpError('队长字号模式须为 auto 或 custom');
    return v;
  },
  teamCaptainSize: (v) => intRange(v, 8, 120, '队长标签字号须为 8–120'),
  teamCaptainColor: (v) => hexOrEmpty(v, '队长标签颜色须为 #rrggbb 或留空'),
  teamMemberLayout: (v) =>
    (['auto', 'row', 'column'].includes(v)
      ? v
      : (() => { throw new OpError('成员卡片排列须为 auto / row / column'); })()),

  // ---- 功能开关 ----
  featureAvatarEdit: (v) => boolStrict(v, '头像修改开关'),
  featureSettingsResize: (v) => boolStrict(v, '设置窗口缩放开关'),
  featureBatchAdd: (v) => boolStrict(v, '批量添加开关'),
  featureSearch: (v) => boolStrict(v, '搜索开关'),
  featureQuickScore: (v) => boolStrict(v, '快捷记分开关'),
  featureTeamScore: (v) => boolStrict(v, '团队记分开关'),
  featureSpotlightTrigger: (v) => boolStrict(v, '手动突显开关'),
  featureUndo: (v) => boolStrict(v, '撤销开关'),
  featureResetScores: (v) => boolStrict(v, '重置分数开关'),
  featureClock: (v) => boolStrict(v, '时钟开关'),
  featureCountdown: (v) => boolStrict(v, '倒计时开关'),
  featureLeaderboard: (v) => boolStrict(v, '排行榜开关'),
  featureRankTies: (v) => boolStrict(v, '并列名次开关'),
  featureExportImport: (v) => boolStrict(v, '导出导入开关'),
  featureCsvExport: (v) => boolStrict(v, 'CSV 导出开关'),
  featureDataMaintenance: (v) => boolStrict(v, '数据维护开关'),

  // ---- 大屏演示 ----
  clockPosition: (v) =>
    (['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(v)
      ? v
      : (() => { throw new OpError('时钟位置非法'); })()),
  clockFormat: (v) =>
    (['24', '12'].includes(v) ? v : (() => { throw new OpError('时钟制式非法'); })()),
  clockShowSeconds: (v) => boolStrict(v, '时钟秒数开关'),
  clockShowDate: (v) => boolStrict(v, '时钟日期开关'),
  clockFont: fontChoice('时钟字体'),
  clockFontCustom: fontNameOrEmpty,
  clockFontSize: (v) => intRange(v, 0, 200, '时钟字号须为 0–200（0=自动）'),
  countdownDurationSec: (v) => intRange(v, 1, 3600, '倒计时时长须为 1–3600 秒'),
  countdownDisplayMode: (v) =>
    (['corner', 'center', 'fullscreen'].includes(v)
      ? v
      : (() => { throw new OpError('倒计时显示模式非法'); })()),
  countdownTheme: (v) =>
    (['classic', 'ink', 'video'].includes(v)
      ? v
      : (() => { throw new OpError('倒计时主题非法'); })()),
  countdownShape: (v) =>
    (['circle', 'square', 'rounded', 'rounded-rect', 'rect'].includes(v)
      ? v
      : (() => { throw new OpError('倒计时窗口形状非法'); })()),
  countdownRadius: (v) => intRange(v, 0, 120, '倒计时圆角须为 0–120'),
  countdownSize: (v) => intRange(v, 200, 900, '倒计时窗口尺寸须为 200–900'),
  countdownHeight: (v) => intRange(v, 0, 900, '倒计时窗口高度须为 0–900（0=与宽度相同）'),
  countdownFontSize: (v) => intRange(v, 0, 300, '倒计时数字字号须为 0–300（0=自动）'),
  countdownFont: fontChoice('倒计时字体'),
  countdownFontCustom: fontNameOrEmpty,
  countdownPosition: (v) =>
    (['center', 'top-left', 'top', 'top-right', 'left', 'right',
      'bottom-left', 'bottom', 'bottom-right'].includes(v)
      ? v
      : (() => { throw new OpError('倒计时窗口位置非法'); })()),
  countdownShowProgress: (v) => boolStrict(v, '倒计时进度环开关'),
  countdownShowBackdrop: (v) => boolStrict(v, '倒计时遮罩开关'),
  countdownBg: (v) => hexOrEmpty(v, '倒计时窗口底色须为 #rrggbb 或留空'),
  countdownBgMode: (v) =>
    (['theme', 'custom', 'translucent', 'acrylic'].includes(v)
      ? v
      : (() => { throw new OpError('倒计时窗口背景模式非法'); })()),
  countdownBlur: (v) => intRange(v, 0, 40, '倒计时亚克力模糊须为 0–40'),
  countdownOpacity: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.2 || n > 1) throw new OpError('倒计时窗口不透明度须在 0.2–1 之间');
    return Math.round(n * 100) / 100;
  },
  countdownTextColor: (v) => hexOrEmpty(v, '倒计时文字颜色须为 #rrggbb 或留空'),
  displayView: (v) =>
    (['cards', 'leaderboard', 'welcome'].includes(v)
      ? v
      : (() => { throw new OpError('显示视图非法'); })()),
  displayResolution: (v) => {
    if (v === 'auto') return 'auto';
    const match = typeof v === 'string' ? /^(\d{3,5})x(\d{3,5})$/.exec(v) : null;
    if (!match) throw new OpError('显示分辨率须为 auto 或 WxH（如 3840x2160）');
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width < 320 || width > 15360 || height < 240 || height > 8640) {
      throw new OpError('显示分辨率须在 320–15360 × 240–8640 之间');
    }
    return width + 'x' + height;
  },
  displayResolutionScale: (v) =>
    intRange(v, 0, 100, '显示分辨率放大强度须为 0–100'),
  leaderboardScope: (v) =>
    (['auto', 'people', 'teams'].includes(v) ? v : (() => { throw new OpError('排行榜范围非法'); })()),
  leaderboardLimit: (v) => intRange(v, 0, 200, '排行榜条数须为 0–200'),
  leaderboardScale: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.8 || n > 1.6) throw new OpError('排行榜缩放须在 0.8–1.6 之间');
    return Math.round(n * 100) / 100;
  },
  leaderboardFont: fontChoice('排行榜字体'),
  leaderboardFontCustom: fontNameOrEmpty,
  rankTieMode: (v) =>
    (['competition', 'dense', 'none'].includes(v)
      ? v
      : (() => { throw new OpError('并列名次模式非法'); })()),

  // ---- 记分效率与动效 ----
  quickScorePresets: (v) => {
    if (!Array.isArray(v)) throw new OpError('快捷分预设须为数组');
    if (v.length < 1 || v.length > 6) throw new OpError('快捷分预设须为 1–6 个');
    const out = v.map((n) => {
      const num = Number(n);
      if (!Number.isInteger(num) || num === 0 || Math.abs(num) > 10000) {
        throw new OpError('快捷分预设每项须为 ±10000 内非 0 整数');
      }
      return num;
    });
    return out;
  },
  scoreRolling: (v) => boolStrict(v, '滚动数字开关'),
  sortAnimation: (v) => boolStrict(v, '排序重排开关'),
  rankChangeAnimation: (v) => boolStrict(v, '名次升降开关'),
  featureMarquee: (v) => boolStrict(v, '跑马灯开关'),
  bgmEnabled: (v) => boolStrict(v, '背景音乐开关'),
  bgmFile: (v) => needSoundPath(v, '背景音乐路径'),
  bgmVolume: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new OpError('背景音乐音量须在 0–1 之间');
    return Math.round(n * 100) / 100;
  },
  bgmLoop: (v) => boolStrict(v, '背景音乐循环开关'),
  featureBuzzer: (v) => boolStrict(v, '抢答模式开关'),
  featureTeamPk: (v) => boolStrict(v, '团队 PK 开关'),
  featureCarousel: (v) => boolStrict(v, '轮播开关'),
  carouselViews: (v) => {
    if (!Array.isArray(v)) throw new OpError('轮播视图须为数组');
    if (v.length < 1 || v.length > 5) throw new OpError('轮播视图须为 1–5 个');
    const allowed = ['cards', 'leaderboard', 'welcome'];
    const out = v.map((x) => {
      if (!allowed.includes(x)) throw new OpError('轮播视图取值非法');
      return x;
    });
    return out;
  },
  carouselIntervalSec: (v) => intRange(v, 3, 300, '轮播间隔须为 3–300 秒'),
  featureWelcome: (v) => boolStrict(v, '欢迎幕布开关'),
  marqueeText: (v) => (typeof v === 'string' ? v.slice(0, 200) : ''),
  marqueeFontSize: (v) => intRange(v, 0, 120, '跑马灯字号须为 0–120（0=自动）'),
  marqueeFont: fontChoice('跑马灯字体'),
  marqueeFontCustom: fontNameOrEmpty,
  marqueePosition: (v) =>
    (['top', 'bottom'].includes(v) ? v : (() => { throw new OpError('跑马灯位置非法'); })()),
  marqueeEffect: (v) =>
    (['scroll', 'blink', 'none'].includes(v)
      ? v
      : (() => { throw new OpError('跑马灯特效非法'); })()),
  marqueeColor: (v) => hexOrEmpty(v, '跑马灯文字颜色须为 #rrggbb 或留空'),
  marqueeBgColor: (v) => hexOrEmpty(v, '跑马灯背景色须为 #rrggbb 或留空'),
  marqueeSpeed: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0.5 || n > 3) throw new OpError('跑马灯速度须在 0.5–3 之间');
    return Math.round(n * 100) / 100;
  },
  welcomeText: (v) => (typeof v === 'string' ? v.slice(0, 200) : ''),
  welcomeFont: fontChoice('欢迎幕布字体'),
  welcomeFontCustom: fontNameOrEmpty,
  welcomeFontSize: (v) => intRange(v, 0, 300, '欢迎幕布字号须为 0–300（0=自动）'),
  welcomeImage: (v) => needAvatar(v === '' ? null : v),
  welcomeBgColor: (v) => hexOrEmpty(v, '欢迎幕布底色须为 #rrggbb 或留空'),
  featureMobileAdmin: (v) => boolStrict(v, '管理端移动布局开关'),
  adminTouchTargetSize: (v) => intRange(v, 40, 64, '触控目标尺寸须为 40–64'),
};


module.exports = { DEFAULT_SETTINGS, THEME_SETTING_KEYS, SETTINGS_VALIDATORS };
