/**
 * 任务类型落在用户数据目录里（src/task_types.ts）：服务启动时从产品自带的那一份播种、写 manifest.json；已有的不覆盖；
 * 产品带来的新类型照样播种；建任务、任务类型清单与类型版本都看用户目录里的那一份。
 */

import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { appVersion } from "../src/paths.ts";
import { Service, taskTypeVersion } from "../src/service.ts";
import { readTaskJson } from "../src/task_json.ts";
import { MANIFEST_NAME, definitionFileOf, listTaskTypes, readManifest, seedTaskTypes, taskTypesRoot } from "../src/task_types.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";

captureConsole();
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const SHIPPED = join(ROOT, "task-types");
const KEY = "requirements-engineering";

test("播种：数据目录下还没有 task-types 时把产品自带的每种任务类型整个复制过去，manifest.json 记来源版本、时刻与产品版本；再播一次什么都不做", () => {
  const data = join(tmp, "seed");
  assert.deepEqual(seedTaskTypes(data, "0.6.0"), [KEY]);
  const root = taskTypesRoot(data);
  assert.deepEqual(readdirSync(root).sort(), [MANIFEST_NAME, KEY]);
  assert.equal(readFileSync(join(root, KEY, definitionFileOf(KEY)), "utf-8"), readFileSync(join(SHIPPED, KEY, definitionFileOf(KEY)), "utf-8"));
  const seeded = readManifest(root).types[KEY];
  assert.deepEqual([seeded.source_version, seeded.product_version], [taskTypeVersion(KEY), "0.6.0"]);
  assert.match(seeded.seeded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(listTaskTypes(root), [{ task_type: KEY, name: "需求工程" }]);
  assert.deepEqual(seedTaskTypes(data, "0.6.1"), [], "已经有了，不再播种");
  assert.equal(readManifest(root).types[KEY].product_version, "0.6.0");
});

test("已有的不覆盖：用户目录里改过的那一份照旧；产品自带里多出来的新类型照样播种，manifest 两种都记着", () => {
  const data = join(tmp, "keep");
  seedTaskTypes(data, "0.6.0");
  const root = taskTypesRoot(data);
  const skill = join(root, KEY, ".pi", "skills", KEY, "SKILL.md");
  writeFileSync(skill, "用户改过的说明。\n", "utf-8");
  // 一份产品自带的目录，里面多了一种任务类型；另有一个没有新格式任务定义的目录，不算任务类型，不播种。
  const shipped = join(tmp, "shipped");
  cpSync(SHIPPED, shipped, { recursive: true });
  cpSync(join(shipped, KEY), join(shipped, "demo-type"), { recursive: true });
  const def = join(shipped, "demo-type", "docs", "task-definitions");
  writeFileSync(join(def, "demo-type.json"), readFileSync(join(def, `${KEY}.json`), "utf-8").replace('"任务名": "需求工程"', '"任务名": "演示类型"'), "utf-8");
  rmSync(join(def, `${KEY}.json`));
  cpSync(join(shipped, KEY, "README.md"), join(shipped, "not-a-type", "README.md"));
  assert.deepEqual(seedTaskTypes(data, "0.7.0", shipped), ["demo-type"]);
  assert.equal(readFileSync(skill, "utf-8"), "用户改过的说明。\n");
  assert.equal(existsSync(join(root, "not-a-type")), false);
  assert.deepEqual(Object.keys(readManifest(root).types).sort(), ["demo-type", KEY]);
  assert.deepEqual(listTaskTypes(root).map((one) => one.name), ["演示类型", "需求工程"]);
});

test("任务服务启动时播种；建任务从用户目录复制，任务类型清单与 task.json 里的类型版本看用户目录里的那一份", async () => {
  const data = join(tmp, "service");
  const service = new Service(join(data, "tasks"), join(data, "runs"), {}, { port: 1, dataDir: data });
  try {
    const root = taskTypesRoot(data);
    assert.equal(readManifest(root).types[KEY].product_version, appVersion());
    // 用户在自己的目录里把任务名与版本改了：清单与新建的任务都看这一份。
    const file = join(root, KEY, definitionFileOf(KEY));
    writeFileSync(file, readFileSync(file, "utf-8").replace('"任务名": "需求工程"', '"任务名": "需求工程（本单位）"').replace(/"版本": \d+/, '"版本": 99'), "utf-8");
    assert.deepEqual(listTaskTypes(service.typesRoot), [{ task_type: KEY, name: "需求工程（本单位）" }]);
    const id = service.create({ task_type: KEY, task_name: "借阅" }).task_id as string;
    const dir = join(data, "tasks", id);
    assert.equal(readFileSync(join(dir, definitionFileOf(KEY)), "utf-8"), readFileSync(file, "utf-8"));
    assert.equal(readTaskJson(dir)?.task_type_version, 99);
  } finally {
    await service.close();
  }
});
