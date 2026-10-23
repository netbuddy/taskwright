/**
 * 读缺失的材料（lib/missing_material.ts 与 hooks/missing_material.ts）：材料表里有这份材料而文件不在时，自带的 read 读它、
 * 或者读由它生成的文字版，都被拦下，工具结果是请用户补齐的那句话；文件在的材料、材料表里没有的路径、材料目录之外的路径、
 * grep 与没有任务库的目录都放行。
 */

import assert from "node:assert/strict";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { insertMaterial, retireMaterial } from "../src/lib/material_db.ts";
import { missingMaterialOf } from "../src/lib/missing_material.ts";
import { missingMaterialBlock } from "../src/hooks/missing_material.ts";
import { DEFINITION_PATH, callIn, makeWorkspace, tempDir } from "./helpers.ts";

const SENTENCE = "材料 规格说明.docx 的文件缺失，请用户在材料页补齐后再读；不要凭记忆补写它的内容。";

/** 一个任务：材料表里记着 inputs/规格说明.docx 与 inputs/材料.md 两份，前一份的文件不在（导入了不带材料的包），后一份在。 */
function workspace(): string {
  const dir = makeWorkspace();
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  insertMaterial(dir, "inputs/规格说明.docx", { slot: "spec", role: "既有规格说明" });
  insertMaterial(dir, "inputs/材料.md", { slot: null, role: "证据" });
  return dir;
}
const read = (dir: string, path: string) => missingMaterialBlock({ toolName: "read", input: { path } }, { cwd: dir });

test("read 读材料表里有而文件不在的材料：拦下，工具结果是请用户补齐的那句话；绝对路径与 @ 开头的写法一样", () => {
  const dir = workspace();
  assert.deepEqual(read(dir, "inputs/规格说明.docx"), { block: true, reason: SENTENCE });
  assert.deepEqual(read(dir, join(dir, "inputs/规格说明.docx")), { block: true, reason: SENTENCE });
  assert.deepEqual(read(dir, "@inputs/规格说明.docx"), { block: true, reason: SENTENCE });
});

test("read 读缺失材料生成的文字版、分段清单、位置表：按原件算，同样拦下", () => {
  const dir = workspace();
  for (const suffix of [".md", ".segments.json", ".locations.json"]) {
    assert.deepEqual(read(dir, `inputs/规格说明.docx${suffix}`), { block: true, reason: SENTENCE }, suffix);
  }
  assert.equal(missingMaterialOf(dir, { path: "inputs/规格说明.docx.md" }), "inputs/规格说明.docx");
});

test("放行：文件在的材料、材料表里没有的路径、材料目录之外的路径、grep、没有任务库的目录", () => {
  const dir = workspace();
  assert.equal(read(dir, "inputs/材料.md"), undefined);
  assert.equal(read(dir, "inputs/没有登记的.md"), undefined);
  assert.equal(read(dir, "docs/没有的说明.md"), undefined);
  assert.equal(missingMaterialBlock({ toolName: "grep", input: { pattern: "x", path: "inputs/规格说明.docx" } }, { cwd: dir }), undefined);
  assert.equal(read(makeWorkspace(), "inputs/规格说明.docx"), undefined, "没有任务库");
});

test("文件不在而材料表那一行还在算缺失；那一行记了删除的时刻（用户删掉了这份材料）就不算", () => {
  const dir = workspace();
  rmSync(join(dir, "inputs/材料.md"));
  assert.equal(read(dir, "inputs/材料.md")?.reason, "材料 材料.md 的文件缺失，请用户在材料页补齐后再读；不要凭记忆补写它的内容。");
  retireMaterial(dir, "inputs/材料.md");
  assert.equal(read(dir, "inputs/材料.md"), undefined);
});

test("任务目录经过符号链接时照样认出缺失的材料", () => {
  const dir = workspace();
  const link = join(tempDir("taskwright-agent-link-"), "task");
  symlinkSync(dir, link);
  assert.deepEqual(read(link, "inputs/规格说明.docx"), { block: true, reason: SENTENCE });
});
