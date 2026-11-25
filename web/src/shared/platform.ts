/** 运行环境判断：Electron 壳与普通浏览器共用同一套前端代码。 */
export function isElectronRuntime(): boolean {
  return typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);
}
