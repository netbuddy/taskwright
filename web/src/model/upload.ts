// 上传之前按后端给的上限判断文件是不是太大、按后端给的扩展名判断类型对不对，按扩展名过滤可选的文件，写上传框的说明。
// 上限、扩展名、类型给人看的叫法与两句拒绝的话都来自服务信息接口（GET /api/v1/service 的 upload），前端不另写一份。

import type { ServiceInfo } from "../api/types";

/** 文件超过上限时返回后端给的那句话，不超过或还没取到服务信息时返回 null（这时照常发给后端，由后端拒绝）。 */
export function tooLargeText(info: ServiceInfo | null, file: { size: number }): string | null {
  const upload = info?.upload;
  if (!upload) return null;
  return file.size > upload.max_bytes ? upload.too_large_text : null;
}

/**
 * 文件类型不在后端给的扩展名里时返回后端给的那句话；类型对、或者还没取到服务信息（扩展名与那句话缺一样）时返回 null，
 * 这时照常发给后端，由后端判断。扩展名的比较与后端相同：文件名转小写之后以某个扩展名结尾。
 */
export function unsupportedTypeText(info: ServiceInfo | null, file: { name: string }): string | null {
  const extensions = info?.upload?.extensions;
  const text = info?.upload?.unsupported_type_text;
  if (!extensions || !extensions.length || !text) return null;
  const name = file.name.toLowerCase();
  return extensions.some((ext) => name.endsWith(ext.toLowerCase())) ? null : text;
}

/** 上传框说明里写大小的那半句，例如「单个不超过 5 MB」；数字的写法与后端那句「单个文件不能超过 5 MB。」相同。没有服务信息时为 null，说明里就不写大小。 */
export function uploadLimitText(info: ServiceInfo | null): string | null {
  const upload = info?.upload;
  if (!upload) return null;
  return `单个不超过 ${upload.max_bytes / 1024 / 1024} MB`;
}

/** 文件选择框的 accept：后端给的扩展名用逗号连起来。没有服务信息时为 undefined，不过滤，照常发给后端由后端拒绝。 */
export function uploadAccept(info: ServiceInfo | null): string | undefined {
  const extensions = info?.upload?.extensions;
  return extensions && extensions.length ? extensions.join(",") : undefined;
}

/**
 * 上传框说明里写类型的那半句，例如「只收 .md、.txt 与 Word 的 .docx」：「只收」之后是后端给的 types_text（叫法与连法都在后端，
 * 与类型不符时那句话里的写法相同）。没有服务信息或没有这一项时为 null，说明里就不写类型。
 */
export function uploadTypesText(info: ServiceInfo | null): string | null {
  const text = info?.upload?.types_text;
  return text ? `只收 ${text}` : null;
}
