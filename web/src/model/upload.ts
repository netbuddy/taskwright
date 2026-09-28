// 上传之前按后端给的上限判断文件是不是太大。上限与那句话都来自服务信息接口（GET /api/v1/service 的 upload），前端不另写一份。

import type { ServiceInfo } from "../api/types";

/** 文件超过上限时返回后端给的那句话，不超过或还没取到服务信息时返回 null（这时照常发给后端，由后端拒绝）。 */
export function tooLargeText(info: ServiceInfo | null, file: { size: number }): string | null {
  const upload = info?.upload;
  if (!upload) return null;
  return file.size > upload.max_bytes ? upload.too_large_text : null;
}

/** 上传框说明里写大小的那半句，例如「单个不超过 5 MB」；数字的写法与后端那句「单个文件不能超过 5 MB。」相同。没有服务信息时为 null，说明里就不写大小。 */
export function uploadLimitText(info: ServiceInfo | null): string | null {
  const upload = info?.upload;
  if (!upload) return null;
  return `单个不超过 ${upload.max_bytes / 1024 / 1024} MB`;
}
