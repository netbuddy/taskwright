/**
 * PDF 材料投影的命令行入口：给定一份 .pdf，在它旁边写出投影、分段清单与位置表（怎样解析只在 pdf_projection.ts 里写一份）。
 * 用来走查一份 PDF 解析出来是什么样子；将来上传 PDF 材料时要给解析设硬性的时限，也是另起一次运行来跑它、到时没回来就停掉。
 *
 * 用法：
 *   node src/pdf_projection_cli.mts --pdf <.pdf 文件> --rel <它相对任务目录的路径，如 inputs/x.pdf> [--segments-json '<分段参数>']
 *        [--max-pages <页数>] [--max-chars <字数>] [--max-seconds <秒>] [--print]
 *
 * 不带 --print 时在 .pdf 旁边写「x.pdf.md」「x.pdf.segments.json」「x.pdf.locations.json」；分段参数是启动配置「材料分段」一节的 JSON，
 * 不给时用默认值；三个上限不给时用 pdf_projection.ts 的 PDF_LIMITS。带 --print 时什么都不写，投影全文与位置表放在结果里。
 * 结果写到标准输出，一行 JSON：成功是 {"ok": true, "projection": 投影路径或 null, "segments": 分段清单路径或 null,
 * "locations": 位置表路径或 null, "pages": 总页数, "units": 块的总数, "chars": 去掉空白后的字数, "no_text_pages": [没有读出文字的页],
 * "markdown"?: 投影全文, "location_table"?: 位置表}，退出码 0；失败是 {"ok": false, "error": "给人看的一句中文"}，退出码 1。
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type SegmentParams, segmentParams } from "../../agent/src/lib/segments.ts";
import { PDF_LIMITS, type PdfLimits, pdfProjection, writePdfProjection } from "./pdf_projection.ts";

function fail(message: string): never {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exit(1);
}

const OPTIONS = {
  pdf: { type: "string" }, rel: { type: "string" }, print: { type: "boolean" }, "segments-json": { type: "string" },
  "max-pages": { type: "string" }, "max-chars": { type: "string" }, "max-seconds": { type: "string" },
} as const;

let values: { pdf?: string; rel?: string; print?: boolean; "segments-json"?: string; "max-pages"?: string; "max-chars"?: string; "max-seconds"?: string };
try {
  ({ values } = parseArgs({ options: OPTIONS, strict: true }));
} catch (e) {
  fail(`参数不对：${(e as Error).message}`);
}
if (!values.pdf || !values.rel) fail("要给 --pdf 与 --rel。");

let params: SegmentParams;
try {
  params = segmentParams(values["segments-json"]);
} catch (e) {
  fail((e as Error).message);
}

const limits: PdfLimits = { ...PDF_LIMITS };
for (const [option, name] of [["max-pages", "pages"], ["max-chars", "chars"], ["max-seconds", "seconds"]] as const) {
  const raw = values[option];
  if (raw === undefined) continue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`--${option} 应当是正数，现在是 ${raw}。`);
  limits[name] = value;
}

try {
  if (values.print) {
    let data: Buffer;
    try {
      data = readFileSync(values.pdf);
    } catch {
      fail(`读不到文件 ${values.pdf}。`);
    }
    const result = await pdfProjection(data, values.rel, limits);
    process.stdout.write(JSON.stringify({
      ok: true, projection: null, segments: null, locations: null, pages: result.pages, units: result.units, chars: result.chars,
      no_text_pages: result.no_text_pages, markdown: result.markdown, location_table: result.locations,
    }) + "\n");
  } else {
    const written = await writePdfProjection(values.pdf, values.rel, params, limits);
    process.stdout.write(JSON.stringify({ ok: true, ...written }) + "\n");
  }
} catch (e) {
  fail((e as Error).message);
}
