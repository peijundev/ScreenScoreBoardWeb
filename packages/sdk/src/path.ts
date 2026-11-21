/** 对路径参数做 URI 编码，避免项目名/文件名中的特殊字符破坏路由。 */
export function enc(value: string | number): string {
  return encodeURIComponent(String(value));
}
