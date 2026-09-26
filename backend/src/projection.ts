/**
 * Word 材料（.docx）的文本投影：上传 .docx 时在同一目录生成一份给助手读的文本，保存修订时逐字核对也对着它。
 *
 * 投影怎样写只有一份实现，后端这里不重写，只做一层薄适配：现在经子进程调用 Python 服务端里的投影函数
 * （server/taskwright_server/service/docx_text.py）；等 agent 侧有了投影函数，改成在同一进程里直接调用它，只改本文件。
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.ts";

export const SUFFIX = ".txt";

/** 投影失败（不是合法的 .docx）。消息是给人看的一句中文，例如「不是 Word 文件（.docx），或者文件已损坏」。 */
export class ProjectionError extends Error {}

/** 以 .docx.txt 结尾的文件名留给投影用，用户不能上传这种名字。 */
export function isProjection(name: string): boolean {
  return name.toLowerCase().endsWith(".docx" + SUFFIX);
}

export function projectionPath(docx: string): string {
  return docx + SUFFIX;
}

const SCRIPT = `
import json, sys
from pathlib import Path
from taskwright_server.service import docx_text
mode, rel = sys.argv[1], sys.argv[2]
try:
    if mode == "text":
        out = {"ok": True, "text": docx_text.projection_text(sys.stdin.buffer.read(), rel)}
    else:
        docx_text.write_projection(Path(sys.argv[3]), rel)
        out = {"ok": True}
except ValueError as e:
    out = {"ok": False, "error": str(e)}
sys.stdout.write(json.dumps(out, ensure_ascii=False))
`;

function run(args: string[], input?: Buffer): { ok: boolean; text?: string; error?: string } {
  const python = process.env.TASKWRIGHT_PYTHON || "python3";
  const done = spawnSync(python, ["-c", SCRIPT, ...args], {
    input, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, timeout: 60000, windowsHide: true,
    env: { ...process.env, PYTHONPATH: join(REPO_ROOT, "server") },
  });
  if (done.status !== 0) throw new Error(`投影子进程失败：${done.error?.message ?? done.stderr.trim()}`);
  return JSON.parse(done.stdout);
}

/** .docx 的字节 → 投影全文。rel 是这份 .docx 相对任务目录的路径。不是合法的 .docx 时抛 ProjectionError。 */
export function projectionText(data: Buffer, rel: string): string {
  const out = run(["text", rel], data);
  if (!out.ok) throw new ProjectionError(out.error);
  return out.text!;
}

/** 在 .docx 旁边写投影，返回投影的路径。 */
export function writeProjection(docx: string, rel: string): string {
  const out = run(["write", rel, docx]);
  if (!out.ok) throw new ProjectionError(out.error);
  return projectionPath(docx);
}
