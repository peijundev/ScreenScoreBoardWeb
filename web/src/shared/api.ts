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

/** 有上传头像用头像，否则生成姓名首字的彩色 SVG */
export function avatarURL(entity: AvatarSource | null | undefined, size = 96): string {
  if (entity?.avatar) return '/' + entity.avatar;
  const name = entity?.name || '?';
  const ch = Array.from(name)[0] || '?';
  const color = nameColor(name);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '">' +
    '<rect width="100%" height="100%" rx="50%" fill="' + color + '"/>' +
    '<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-size="' +
    Math.round(size * 0.48) +
    '" fill="#fff" font-family="sans-serif">' + escapeXML(ch) + '</text></svg>';
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
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
