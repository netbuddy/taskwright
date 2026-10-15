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
import { ServiceDb } from "../src/service_db.ts";
import { MANIFEST_NAME, TaskTypeError, definitionFileOf, listTaskTypes, readManifest, recordSeedRevisions, restoreTaskTypeRevision, revisionNumbers, revisionsDir, saveTaskTypeRevision, seedTaskTypes, taskTypesRoot } from "../src/task_types.ts";
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
  assert.deepEqual(readdirSync(root).sort(), [".revisions", MANIFEST_NAME, KEY]);
  assert.deepEqual(readdirSync(join(root, ".revisions", KEY)), ["1"], "播种那一刻存成修订 1");
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

test("任务服务启动时播种；建任务从用户目录复制，任务类型清单与 task.json 里的类型版本、修订号看用户目录里的那一份", async () => {
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
    // 记下用的是第几个修订：用户目录里这种类型改过一次（修订 2）之后建的任务记 2。
    assert.equal(readTaskJson(dir)?.task_type_revision, 1);
    assert.equal(saveTaskTypeRevision(data, service.registry, KEY, { "docs/domain-knowledge/本单位.md": "本单位的写法。\n" }, "user", "补一份"), 2);
    const later = service.create({ task_type: KEY, task_name: "还书" }).task_id as string;
    assert.equal(readTaskJson(join(data, "tasks", later))?.task_type_revision, 2);
    assert.ok(existsSync(join(data, "tasks", later, "docs/domain-knowledge/本单位.md")));
  } finally {
    await service.close();
  }
});

test("修订与回退：改一份文件存成修订 2 并记下经过；改坏任务定义被拒、什么都不动；回退到修订 1 是新的修订 3，内容与修订 1 一样，不删任何修订", () => {
  const data = join(tmp, "revise");
  seedTaskTypes(data, "0.6.0");
  const registry = ServiceDb.open(data, "0.6.0");
  try {
    recordSeedRevisions(data, registry);
    const root = taskTypesRoot(data);
    const skillPath = `.pi/skills/${KEY}/SKILL.md`;
    const original = readFileSync(join(root, KEY, skillPath), "utf-8");
    // 修订 1 是播种：每份文件都记作新加。
    const first = registry.taskTypeRevisions(KEY);
    assert.deepEqual(first.map((one) => [one.revision_no, one.actor, one.note]), [[1, "system", `从产品自带的第 ${taskTypeVersion(KEY)} 版播种`]]);
    assert.ok(first[0].files.some((one) => one.path === skillPath && one.change === "added"));

    // 修订 2：改 skill、加一份规矩文档。
    const two = saveTaskTypeRevision(data, registry, KEY, { [skillPath]: original + "\n补一句本单位的约定。\n", "docs/domain-knowledge/本单位.md": "本单位的写法。\n" }, "user", "补本单位的约定");
    assert.equal(two, 2);
    assert.ok(readFileSync(join(root, KEY, skillPath), "utf-8").endsWith("补一句本单位的约定。\n"));
    assert.deepEqual(registry.taskTypeRevisions(KEY).at(-1)!.files.map((one) => [one.path, one.change]),
      [[skillPath, "changed"], ["docs/domain-knowledge/本单位.md", "added"]]);
    assert.deepEqual(revisionNumbers(data, KEY), [1, 2]);
    assert.equal(readFileSync(join(revisionsDir(data, KEY), "2", skillPath), "utf-8"), readFileSync(join(root, KEY, skillPath), "utf-8"));
    // 什么都没有改到：不记新修订。
    assert.equal(saveTaskTypeRevision(data, registry, KEY, { [skillPath]: readFileSync(join(root, KEY, skillPath), "utf-8") }, "user", "没改"), null);

    // 改坏任务定义：被拒，当前版与修订都不动。
    assert.throws(() => saveTaskTypeRevision(data, registry, KEY, { [definitionFileOf(KEY)]: "{不是 JSON" }, "user", "改坏"), TaskTypeError);
    assert.throws(() => saveTaskTypeRevision(data, registry, KEY, { "../外面.md": "x" }, "user", "跑出目录"), /不跑出这个目录/);
    assert.deepEqual(revisionNumbers(data, KEY), [1, 2]);
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(`.${KEY}.`)), [], "暂存目录都清掉了");

    // 回退到修订 1：新的修订 3，内容与修订 1 一样；规矩文档删了、skill 改回来了。
    assert.equal(restoreTaskTypeRevision(data, registry, KEY, 1, "user"), 3);
    assert.equal(readFileSync(join(root, KEY, skillPath), "utf-8"), original);
    assert.equal(existsSync(join(root, KEY, "docs/domain-knowledge/本单位.md")), false);
    const three = registry.taskTypeRevisions(KEY).at(-1)!;
    assert.deepEqual([three.revision_no, three.note, three.files.map((one) => [one.path, one.change])],
      [3, "回退到修订 1", [[skillPath, "changed"], ["docs/domain-knowledge/本单位.md", "removed"]]]);
    assert.deepEqual(revisionNumbers(data, KEY), [1, 2, 3]);
    // 已经是那个样子：不记新修订；没有的修订号报错。
    assert.equal(restoreTaskTypeRevision(data, registry, KEY, 1, "user"), null);
    assert.throws(() => restoreTaskTypeRevision(data, registry, KEY, 9, "user"), /没有修订 9/);
  } finally {
    registry.close();
  }
});
