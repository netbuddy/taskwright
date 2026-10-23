/**
 * 数据包里的事件归档与说明（data_pack.ts）：导出缺省不带事件归档（runs/<任务编号>/pi-events），只带对话记录（pi-sessions），清单文件记着没带；
 * 选了带事件归档（命令行 --with-events）才带；没有事件归档的包照样导入；包根上有一份给人看的说明.txt，不在文件清单里，导入时不解出来。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { README_NAME, exportPack, importPack } from "../src/data_pack.ts";
import { ServiceDb } from "../src/service_db.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";
import { dataWith, locations, putArchive, readPack, tree } from "./pack_stack.ts";

captureConsole();
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => join(tmp, `${name}-${++n}`);
const packFile = (name: string) => {
  const dir = fresh("out");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}.taskwright.zip`);
};

/** 一个对话过的任务：归档里有会话文件，也有事件归档。 */
async function oneTask() {
  const where = await dataWith(fresh("data"), ["甲"]);
  const [id] = where.ids;
  const archive = putArchive(where, id);
  return { where, id, archive };
}

test("导出缺省不带事件归档：包里有会话文件，没有 pi-events 下的任何文件；清单文件记着 with_events 为假", async () => {
  const { where, id, archive } = await oneTask();
  const file = packFile("task");
  await exportPack(where, { scope: "task", taskId: id, to: file });
  const { manifest, names } = readPack(file);
  assert.equal(manifest.with_events, false);
  assert.deepEqual(names.filter((one) => one.startsWith(`runs/${id}/`)), [`runs/${id}/${archive[0]}`]);
  assert.equal(names.some((one) => one.includes("/pi-events/")), false);
  assert.equal(manifest.files.some((one) => one.path.includes("/pi-events/")), false);
});

test("选了带事件归档（命令行 --with-events）：pi-events 下的文件都在包里，清单文件记着 with_events 为真", async () => {
  const { where, id, archive } = await oneTask();
  const file = packFile("events");
  const run = spawnSync(process.execPath, [join(ROOT, "backend", "src", "main.mts"), "data", "export", "--data", where.dataDir, "--task", id, "--with-events", "--to", file], { encoding: "utf-8" });
  assert.equal(run.status, 0, run.stderr);
  const { manifest, names } = readPack(file);
  assert.equal(manifest.with_events, true);
  assert.deepEqual(names.filter((one) => one.startsWith(`runs/${id}/`)).sort(), archive.map((one) => `runs/${id}/${one}`).sort());
});

test("没有事件归档的包照样导入：任务导入了，归档里只有会话文件，与原来的会话文件逐个相同", async () => {
  const { where, id } = await oneTask();
  const file = packFile("no-events");
  await exportPack(where, { scope: "task", taskId: id, to: file });
  const target = locations(fresh("target"));
  const registry = ServiceDb.open(target.dataDir, "0.6.0");
  let report;
  try {
    report = await importPack(target, { file, registry, productVersion: "0.6.0" });
  } finally {
    registry.close();
  }
  assert.equal(report.fatal, null);
  assert.deepEqual(report.tasks.map((t) => [t.task_id, t.outcome]), [[id, "imported"]]);
  assert.equal(existsSync(join(target.runsDir, id, "pi-events")), false);
  const sessions = (root: string) => Object.fromEntries(Object.entries(tree(root)).filter(([name]) => name.startsWith("pi-sessions/")));
  assert.deepEqual(tree(join(target.runsDir, id)), sessions(join(where.runsDir, id)));
});

test("包根上有一份说明.txt：写包里有什么、没有什么、怎样导入；不在文件清单里，导入之后数据目录里没有它", async () => {
  const { where, id } = await oneTask();
  const file = packFile("readme");
  await exportPack(where, { scope: "task", taskId: id, to: file });
  const { manifest, names, content } = readPack(file);
  assert.ok(names.includes(README_NAME));
  assert.equal(manifest.files.some((one) => one.path === README_NAME), false);
  const text = content(README_NAME).toString("utf-8");
  for (const part of ["这是 Taskwright 导出的数据包。", "包里有什么", "- 任务库：", "- 对话记录：",
    "- 材料清单：每份材料的文件名、大小、校验值与它的文字版、分段清单、位置表的校验值（manifest.json 里）。",
    "- 材料与知识库的原件和文字版。这个包含条目里的逐字摘录、业务说明的转述与对话记录，不是干净的；要连原件一起带，导出时加 --with-materials。",
    "- 导入后材料页会列出缺的文件，重新上传同一份文件即可补齐。",
    "- 这个任务用的任务类型说明与规则的副本（tasks/<任务编号>/.pi 与 tasks/<任务编号>/docs）。", "包里没有什么",
    "- 运行日志与事件归档（助手每一步的原始记录）。要带上它们，导出时加 --with-events。", "- 产品设置、模型配置与密钥。", "怎样导入",
    "taskwright data import --from <这个文件>", `${id}「甲」`]) {
    assert.ok(text.includes(part), part);
  }
  const target = locations(fresh("target"));
  const registry = ServiceDb.open(target.dataDir, "0.6.0");
  try {
    assert.equal((await importPack(target, { file, registry, productVersion: "0.6.0" })).fatal, null);
  } finally {
    registry.close();
  }
  for (const root of [target.dataDir, target.tasksDir, target.runsDir]) assert.equal(existsSync(join(root, README_NAME)), false, root);
});

test("说明.txt 在带了材料（--with-materials）时照原样写材料一条，不写缺原件与补齐的话", async () => {
  const { where, id } = await oneTask();
  const file = packFile("readme-materials");
  await exportPack(where, { scope: "task", taskId: id, to: file, withMaterials: true });
  const text = readPack(file).content(README_NAME).toString("utf-8");
  assert.ok(text.includes("- 材料：放进任务里的文件和由它们生成的文字版（tasks/<任务编号>/inputs）。"), text);
  for (const part of ["材料清单", "--with-materials", "补齐"]) assert.equal(text.includes(part), false, part);
});
