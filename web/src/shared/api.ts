// HTTP 侧工具：上传与头像回退图，移植自 public/shared.js

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeXML(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

const AVATAR_COLORS = [
  '#e05252', '#e08a3c', '#d8b93c', '#5cb85c',
  '#3ca6a6', '#4f8cff', '#7a5cd6', '#c75ba8',
];

function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

interface AvatarSource {
  name?: string;
  avatar?: string | null;
}

// 首字头像缓存：大屏每帧会为同一批人员重复调用，避免重复生成/编码 SVG
const avatarCache = new Map<string, string>();
const AVATAR_CACHE_LIMIT = 5000;

/** 有上传头像用头像，否则生成姓名首字的彩色 SVG */
export function avatarURL(entity: AvatarSource | null | undefined, size = 96): string {
  if (entity?.avatar) return '/' + entity.avatar;
  const name = entity?.name || '?';
  const key = size + '|' + name;
  const cached = avatarCache.get(key);
  if (cached) return cached;

  const ch = Array.from(name)[0] || '?';
  const color = nameColor(name);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '">' +
    '<rect width="100%" height="100%" rx="50%" fill="' + color + '"/>' +
    '<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-size="' +
    Math.round(size * 0.48) +
    '" fill="#fff" font-family="sans-serif">' + escapeXML(ch) + '</text></svg>';
  const url = 'data:image/svg+xml,' + encodeURIComponent(svg);
  if (avatarCache.size >= AVATAR_CACHE_LIMIT) avatarCache.clear();
  avatarCache.set(key, url);
  return url;
}

async function upload(file: File, endpoint: string): Promise<string> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok) throw new Error(data.error || '上传失败 (' + res.status + ')');
  return data.path as string;
}

export function uploadAvatar(file: File): Promise<string> {
  return upload(file, '/api/avatar');
}

export function uploadSound(file: File): Promise<string> {
  return upload(file, '/api/sound');
}

export interface SoundAsset {
  path: string;
  bytes: number;
  mtime: number;
}

/** 全局音效库：服务器 sounds/ 目录下的所有音频 */
export async function listSoundAssets(): Promise<SoundAsset[]> {
  const res = await fetch('/api/v1/assets');
  const payload = (await res.json().catch(() => ({}))) as {
    data?: { sounds?: SoundAsset[] };
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(payload.error?.message || '读取音效库失败');
  const sounds = payload.data?.sounds;
  return Array.isArray(sounds) ? sounds : [];
}

export async function deleteSound(path: string): Promise<void> {
  const name = String(path || '').replace(/^sounds\//, '');
  const res = await fetch('/api/v1/assets/sounds/' + encodeURIComponent(name), { method: 'DELETE' });
  const payload = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) throw new Error(payload.error?.message || '删除音效失败');
}
