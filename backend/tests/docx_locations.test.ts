/**
 * 位置表「文件名.docx.locations.json」（agent 的 lib/docx_location_input.ts 与 docx_locations.ts）在后端的接线：
 * 上传 Word 文件时随投影与分段清单一起写；材料清单里它带 derived_from，界面不单独列；经材料内容接口能读到；
 * 以 .docx.locations.json 结尾的文件名不能上传；别的文件不生成位置表；同一份文件生成两次逐字相同；写不成时上传被拒绝、不留下东西。
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { dispatch } from "../src/http.ts";
import { isReserved } from "../src/projection.ts";
import { Service } from "../src/service.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";

// 本文件在测试进程里运行会写日志的后端代码，日志收进内存，不写标准输出（原因见 helpers.ts 的 captureConsole）。
captureConsole();

const SAMPLE = join(ROOT, "examples", "library-lending", "requirements-styled.docx");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

async function withTask(body: (service: Service, t: ReturnType<Service["task"]>) => Promise<void> | void) {
  const root = join(tmp, `case-${++n}`);
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1 });
  try {
    await body(service, service.task(service.create({ task_type: "srs-authoring", task_name: "位置表" }).task_id));
  } finally {
    await service.close();
  }
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  return "ok";
}

test("上传 Word 文件：旁边写位置表，文件头与标题段照规则；材料清单里它带 derived_from；经材料内容接口能读到", () => withTask(async (service, t) => {
  service.upload(t, "需求.docx", readFileSync(SAMPLE));
  const file = join(t.dir, "inputs", "需求.docx.locations.json");
  const table = JSON.parse(readFileSync(file, "utf-8"));
  assert.deepEqual(Object.keys(table), ["version", "rules_version", "说明", "source", "paragraphs", "page_marks", "application", "headings"]);
  assert.deepEqual([table.version, table.rules_version, table.source, table.paragraphs, table.page_marks, table.application],
    [1, 2, "inputs/需求.docx", 114, 4, "Microsoft Macintosh Word"]);
  assert.equal(table.headings.length, 15);
  assert.deepEqual(table.headings[0], { paragraph: 6, level: 1, title: "1 概述" });
  assert.deepEqual(table.headings.find((h: { paragraph: number }) => h.paragraph === 75), { paragraph: 75, level: 3, title: "3.1.1 逾期罚款" });
  assert.ok(!readFileSync(file, "utf-8").includes("逾期的每本每天"), "不记正文的文字");

  const listed = service.taskPage(t).materials;
  assert.equal(listed.find((m) => m.path === "inputs/需求.docx.locations.json")?.derived_from, "inputs/需求.docx");

  const res = await dispatch(service, { method: "GET", path: `/api/v1/tasks/${t.taskId}/materials/content`, query: { path: "inputs/需求.docx.locations.json" },
    headers: {}, body: Buffer.alloc(0), remote: "127.0.0.1" }) as { status: number; body: Buffer };
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(JSON.parse(res.body.toString()).text), table);
}));

test("以 .docx.locations.json 结尾的文件名是保留的；它也过不了类型检查，上传被拒绝", () => withTask((service, t) => {
  assert.equal(isReserved("x.docx.locations.json"), true);
  assert.equal(isReserved("X.DOCX.LOCATIONS.JSON"), true);
  assert.equal(isReserved("locations.json"), false);
  assert.equal(codeOf(() => service.upload(t, "需求.docx.locations.json", Buffer.from("{}"))), "unsupported_type");
  assert.deepEqual(readdirSync(join(t.dir, "inputs")), []);
}));

test("不是 Word 文件的材料不生成位置表", () => withTask((service, t) => {
  service.upload(t, "需求.md", Buffer.from("# 需求\n\n一段文字。\n"));
  service.upload(t, "说明.txt", Buffer.from("说明文字。"));
  assert.deepEqual(readdirSync(join(t.dir, "inputs")).sort(), ["说明.txt", "需求.md"]);
}));

test("同一份文件生成两次，位置表逐字相同", async () => {
  const texts: string[] = [];
  for (let k = 0; k < 2; k++) {
    await withTask((service, t) => {
      service.upload(t, "需求.docx", readFileSync(SAMPLE));
      texts.push(readFileSync(join(t.dir, "inputs", "需求.docx.locations.json"), "utf-8"));
    });
  }
  assert.equal(texts[0], texts[1]);
});

test("位置表写不成时与投影写不成一样：上传被拒绝，Word 文件、投影与分段清单都不留下", () => withTask((service, t) => {
  mkdirSync(join(t.dir, "inputs", "需求.docx.locations.json"), { recursive: true }); // 占住位置表的文件名，写文件会失败
  assert.equal(codeOf(() => service.upload(t, "需求.docx", readFileSync(SAMPLE))), "unsupported_type");
  assert.deepEqual(readdirSync(join(t.dir, "inputs")), ["需求.docx.locations.json"], "只剩测试自己放的那个目录");
}));
