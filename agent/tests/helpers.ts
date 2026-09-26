/**
 * 单元测试共用的小夹具：在临时目录里建一个任务目录，放一份小的任务定义。
 * 夹具是测试自己写的，与真实任务的起始文件无关。
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32 } from "node:zlib";
import { databasePath } from "../src/lib/db.ts";
import { docxProjection } from "../src/lib/docx_markdown.ts";
// 仓库脚本是普通 .mjs（只用 Node 自带模块），直接引它的抽取函数
import { paragraphsOf, readZipEntry, tableLabel } from "../../scripts/docx_paragraphs.mjs";

export const DEFINITION_PATH = "docs/task-definitions/demo.json";

/** 一份覆盖四种字段类型的小任务定义。 */
export function demoDefinition(): Record<string, unknown> {
  return {
    任务名: "演示任务",
    交付物: {
      名称: "演示交付物",
      文档模板: "docs/templates/demo.md",
      条目集合: [
        {
          名称: "用例",
          编号前缀: "UC",
          字段: [
            { 名: "名称", 类型: "文本", 必填: true },
            { 名: "步骤", 类型: "文本列表", 必填: true },
            { 名: "备注", 类型: "文本", 必填: false },
          ],
        },
        {
          名称: "问题",
          编号前缀: "TBD",
          字段: [
            { 名: "事项", 类型: "文本", 必填: true },
            { 名: "状态", 类型: "枚举", 必填: true, 取值: ["未解决", "已解决"] },
            { 名: "关联条目", 类型: "条目引用", 必填: false },
          ],
        },
      ],
      每个条目附带: "来源",
    },
    完成条件: {
      用例: ["至少一个条目", "每个条目评审通过", "每个条目用户确认"],
      问题: ["没有状态为未解决的条目"],
    },
    执行方法: ".pi/skills/demo/SKILL.md",
    领域规矩: ["docs/domain-knowledge/demo.md"],
  };
}

/**
 * 夹具里的材料全文。种类为「文档原文」的来源，摘录必须逐字出自出处所指的材料文件，
 * 所以测试里用到的文档原文摘录都要在这里出现。
 */
export const MATERIAL_TEXT = [
  "# 登录与退款",
  "",
  "用户可以登录。登录总要输入口令。用口令登录，叫用口令登录也行。",
  "",
  "退款须在七天内处理完毕。退款要在三天内到账，也有人写退款要在三天之内到账。",
  "",
  "系统要支持并发访问，最多 48个工作小时 内答复。",
  "",
].join("\n");

/** 建一个临时任务目录，写好任务定义文件与一份材料（inputs/材料.md，material 为假时不放），返回任务目录。 */
export function makeWorkspace(definition: unknown = demoDefinition(), { material = true } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "taskwright-agent-test-"));
  mkdirSync(join(dir, "docs/task-definitions"), { recursive: true });
  writeFileSync(join(dir, DEFINITION_PATH), JSON.stringify(definition, null, 2), "utf-8");
  if (material) {
    mkdirSync(join(dir, "inputs"), { recursive: true });
    writeFileSync(join(dir, "inputs/材料.md"), MATERIAL_TEXT, "utf-8");
  }
  return dir;
}

let counter = 0;
/** 一次调用的上下文：会话编号固定，调用编号每次不同，模仿 pi 给的样子。 */
export function callIn(workspaceDir: string, sessionId = "session-test") {
  counter += 1;
  return { workspaceDir, sessionId, callId: `call-${counter}` };
}

/** 以只读方式打开任务目录的库，查完自己关掉。 */
export function query<T = Record<string, unknown>>(workspaceDir: string, sql: string, ...args: unknown[]): T[] {
  const db = new DatabaseSync(databasePath(workspaceDir), { readOnly: true });
  try {
    return db.prepare(sql).all(...(args as never[])) as T[];
  } finally {
    db.close();
  }
}

/** 数一张表有几行。 */
export function count(workspaceDir: string, table: string): number {
  return Number(query<{ n: number }>(workspaceDir, `SELECT COUNT(*) AS n FROM ${table}`)[0].n);
}

/** 一条合格的来源。 */
export const SOURCE = { kind: "文档原文", locator: "inputs/材料.md", excerpt: "用户可以登录。" };

/**
 * Word 材料的样本：examples/library-lending/requirements-styled.docx。投影由 lib/docx_markdown.ts 现生成，与后端上传时相同
 * （后端经 cli/docx_projection.mts 调用同一个函数）。0.2 的纯文本投影按 scripts/docx_paragraphs.mjs 的计数规则现生成，给兼容的测试用。
 */
export const SAMPLE = join(import.meta.dirname, "../../examples/library-lending/requirements-styled.docx");
/** 样本放进任务目录后的出处写法（不带段落号）。 */
export const SAMPLE_DOCX = "inputs/requirements-styled.docx";

/** 样本的 Markdown 投影。 */
export function projection(): string {
  return docxProjection(readFileSync(SAMPLE), SAMPLE_DOCX).markdown;
}

/** 样本的 0.2 纯文本投影：每段一行，行首写「第 N 段」。 */
export function legacyProjection(): string {
  const xml = readZipEntry(readFileSync(SAMPLE), "word/document.xml").toString("utf8");
  const lines = ["# 由 requirements-styled.docx 生成，供助手阅读。"];
  for (const p of paragraphsOf(xml) as { n: number; text: string; table?: unknown[] }[]) {
    lines.push(`[第 ${p.n} 段${p.table ? " · " + tableLabel(p.table) : ""}] ${p.text.replace(/[\r\n]/g, " ")}`);
  }
  return lines.join("\n") + "\n";
}

/** 把样本与它的投影放进任务目录的材料目录（任务目录要已经有 inputs/）；legacy 为真时放 0.2 的纯文本投影。 */
export function putSampleDocx(dir: string, legacy = false): void {
  copyFileSync(SAMPLE, join(dir, SAMPLE_DOCX));
  if (legacy) writeFileSync(join(dir, `${SAMPLE_DOCX}.txt`), legacyProjection(), "utf-8");
  else writeFileSync(join(dir, `${SAMPLE_DOCX}.md`), projection(), "utf-8");
}

/** 一个只含给定部件的 .docx（不压缩的 zip），给构造特定 Word 结构的测试用。document 是 w:body 里的内容。 */
export function makeDocx(body: string, parts: Record<string, string | Buffer> = {}): Buffer {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const files: Record<string, string | Buffer> = { "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`, ...parts };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
