/**
 * 上传 PDF 时生成它的三个派生文件（投影、分段清单、位置表）：另起一次运行来跑命令行入口 pdf_projection_cli.mts，
 * 到时限还没有结束就强行停掉。
 *
 * 为什么不在任务服务自己这里算：解析一份 PDF 可能要几十秒，同步做的话这段时间里任务服务不回应任何页面、也收不到助手的消息；
 * 而且解析库的时限只在页与页之间检查，某一页卡住时停不下来。另起一次运行，卡住了可以从外面停掉它。
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SegmentParams } from "../../agent/src/lib/segments.ts";
import { ENV_RUN_SCRIPT, PDF_RUN_DEFAULTS, type PdfRunLimits, isSingleExecutable } from "./launch.ts";
import { tooSlowText } from "./pdf_projection.ts";

/** 整份 PDF 一个块都没有（扫描件）时的拒绝。 */
export const PDF_NO_TEXT = "这份 PDF 没有可读的文字（可能是扫描件），本版不支持。";

/** 生成不了派生文件：消息是给人看的一句中文。 */
export class PdfUploadError extends Error {}

/** 生成的结果：总页数、块的总数、去掉空白后的字数、没有读出文字的页。 */
export interface PdfParsed { pages: number; units: number; chars: number; no_text_pages: number[] }

/** 命令行入口的文件：仓库里是 .mts，安装包里构建时去掉了类型，是 .mjs。 */
export function pdfCliPath(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./pdf_projection_cli.mts" : "./pdf_projection_cli.mjs", import.meta.url));
}

const sentence = (text: string) => (/[。！？]$/.test(text) ? text : `${text}。`);

/**
 * 在 pdf 旁边生成三个派生文件。rel 是这份 PDF 相对任务目录（或知识库根目录）的路径，写进派生文件里；limits 是启动配置
 * 「PDF 解析」一节的四个数（launch.ts 的 pdfLimitsOf）。
 * 生成不了（不是合法的 PDF、设了口令、超过上限、到时限没有结束）时抛 PdfUploadError；已经写出来的派生文件由调用的一方清理。
 * 到 stop_after_seconds 还没有结束就把那一次运行停掉；它每读完一页报一次进度，所以停掉时说得出读到了第几页。
 * cli 只在测试里给。
 */
export function runPdfProjection(pdf: string, rel: string, segments: SegmentParams, limits: PdfRunLimits = PDF_RUN_DEFAULTS, cli: string = pdfCliPath()): Promise<PdfParsed> {
  // 单个可执行文件里，当前的可执行文件就是 Node，但直接运行它会启动内嵌的程序：把脚本放进 TASKWRIGHT_RUN_SCRIPT 交给引导程序（见 launch.ts 的 piLauncher）。
  const single = isSingleExecutable();
  const args = [...(single ? [] : [cli]), "--pdf", pdf, "--rel", rel, "--segments-json", JSON.stringify(segments), "--progress",
    "--max-pages", String(limits.max_pages), "--max-chars", String(limits.max_chars), "--max-seconds", String(limits.max_seconds)];
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, args, { env: { ...process.env, ...(single ? { [ENV_RUN_SCRIPT]: cli } : {}) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let pending = "";
    let lastError = "";
    let progress: [number, number] | null = null;
    let stopped = false;
    const timer = setTimeout(() => {
      stopped = true;
      child.kill("SIGKILL");
    }, limits.stop_after_seconds * 1000);
    child.stdout.on("data", (chunk) => { out += chunk; });
    // 标准错误输出：进度的各行记下最后一行，别的行留最后一行（没有写出结果时附在说明后面）。
    child.stderr.on("data", (chunk) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const m = /^\{"progress":\[(\d+),(\d+)\]\}$/.exec(line.trim());
        if (m) progress = [Number(m[1]), Number(m[2])];
        else if (line.trim()) lastError = line.trim();
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new PdfUploadError(`解析 PDF 的程序没有运行起来：${error.message}。`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (stopped) return reject(new PdfUploadError(sentence(tooSlowText(performance.now() - started, progress ? progress[0] : null, progress ? progress[1] : null))));
      let answer: Record<string, any> | null = null;
      try {
        answer = JSON.parse(out.trim().split("\n").pop() ?? "");
      } catch {
        // 没有写出结果那一行
      }
      if (answer && answer.ok === true) return resolve({ pages: answer.pages, units: answer.units, chars: answer.chars, no_text_pages: answer.no_text_pages ?? [] });
      if (answer && typeof answer.error === "string") return reject(new PdfUploadError(sentence(answer.error)));
      reject(new PdfUploadError(`解析这份 PDF 没有做成，这一次没有上传。${lastError ? `（${lastError}）` : ""}`));
    });
  });
}
