/**
 * Word 材料 Markdown 投影的命令行入口：给后端上传材料与命令行建任务用。
 *
 * 投影怎样写只在 lib/docx_markdown.ts 里写一份；后端是 Python 写的，每收到一份 .docx 就起一个 Node 子进程运行本文件。
 *
 * 用法：
 *   node cli/docx_projection.mts --docx <.docx 文件> --rel <它相对任务目录的路径，如 inputs/x.docx> [--print]
 *
 * 不带 --print 时在 .docx 旁边写「x.docx.md」，文件里有图片时把投影链接到的图片写进「x.docx.media/」（先清空这个目录）；
 * 带 --print 时什么都不写，投影全文放在结果的 markdown 里。
 * 结果写到标准输出，一行 JSON：成功是 {"ok": true, "projection": 投影路径或 null, "paragraphs": 段落总数, "images": 图片个数,
 * "markdown"?: 投影全文}，退出码 0；失败是 {"ok": false, "error": "给人看的一句中文"}，退出码 1。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MEDIA_SUFFIX, PROJECTION_SUFFIX, docxProjection } from "../lib/docx_markdown.ts";

function fail(message: string): never {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exit(1);
}

let values: { docx?: string; rel?: string; print?: boolean };
try {
  ({ values } = parseArgs({ options: { docx: { type: "string" }, rel: { type: "string" }, print: { type: "boolean" } }, strict: true }));
} catch (e) {
  fail(`参数不对：${(e as Error).message}`);
}
if (!values.docx || !values.rel) fail("要给 --docx 与 --rel。");

let data: Buffer;
try {
  data = readFileSync(values.docx);
} catch {
  fail(`读不到文件 ${values.docx}。`);
}
let result;
try {
  result = docxProjection(data, values.rel);
} catch (e) {
  fail((e as Error).message);
}
if (values.print) {
  process.stdout.write(JSON.stringify({ ok: true, projection: null, paragraphs: result.paragraphs, images: result.media.size, markdown: result.markdown }) + "\n");
  process.exit(0);
}
const projection = values.docx + PROJECTION_SUFFIX;
const media = values.docx + MEDIA_SUFFIX;
try {
  rmSync(media, { recursive: true, force: true });
  if (result.media.size) {
    mkdirSync(media);
    for (const [name, bytes] of result.media) writeFileSync(join(media, name), bytes);
  }
  writeFileSync(projection, result.markdown, "utf-8");
} catch (e) {
  fail(`投影没有写成：${(e as Error).message}`);
}
process.stdout.write(JSON.stringify({ ok: true, projection, paragraphs: result.paragraphs, images: result.media.size }) + "\n");
