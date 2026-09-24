// 几样显示用的写法：时刻、秒数、字节数。

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "未知";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatSeconds(s: number | null | undefined): string {
  if (s == null) return "未知时长";
  if (s < 60) return `${Math.round(s)} 秒`;
  return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} 字节`;
  return `${(n / 1024).toFixed(1)} KB`;
}

export function valueText(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join("；");
  return String(v);
}
