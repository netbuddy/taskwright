// 下载：从响应头里取文件名，把取回的文件交给浏览器保存。

/**
 * Content-Disposition 里的文件名：先看 filename*=UTF-8''…（文件名带中文时任务服务这样写），没有再看 filename="…"；都没有是 null。
 */
export function dispositionFileName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // 写坏了的百分号编码：当作没有，往下看 filename。
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
  return plain ? plain[1].trim() || null : null;
}

/** 让浏览器把这份文件存成 name。 */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
