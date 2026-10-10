/**
 * 命令行的三个数据包命令（真进程，经后端外壳）：data export、data import、data upgrade --pack。都不起服务；
 * 退出码 0 是都做成了，1 是有没做成的，2 是没有做（参数不对、数据目录被占用或有数据要先升级、数据包不对、目标文件已经在）。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { TASK_DB_VERSION } from "../../agent/src/lib/schema.ts";
import { LOCK_NAME } from "../src/occupancy.ts";
import { SERVICE_DB_NAME, ServiceDb } from "../src/service_db.ts";
import { BACKEND_MAIN, ROOT, captureConsole, tempDir } from "./helpers.ts";
import { dataWith, facts, put, putArchive, readPack, repack, tree } from "./pack_stack.ts";

captureConsole();

const SAMPLES = join(ROOT, "backend", "tests", "fixtures", "task_dirs");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => join(tmp, `${name}-${++n}`);
const outDir = () => {
  const dir = fresh("out");
  mkdirSync(dir);
  return dir;
};

/** 运行后端外壳（真进程），等它结束。 */
function run(args: string[]) {
  const done = spawnSync(process.execPath, [BACKEND_MAIN, ...args], { encoding: "utf-8", timeout: 60000 });
  return { status: done.status, out: done.stdout, err: done.stderr };
}

const registered = (data: string) => {
  const db = ServiceDb.read(data);
  try {
    return db ? db.tasks().map((row) => [row.task_id, row.name, row.dir]) : null;
  } finally {
    db?.close();
  }
};

test("导出整套再导入到一个空的数据目录：两个命令都退出 0；再导入一次跳过；加 --renumber 改编号导入", async () => {
  const where = await dataWith(fresh("data"), ["甲", "乙"]);
  const [a, b] = where.ids;
  put(join(where.tasksDir, a, "inputs", "材料.md"), "读者凭借书证借书。\n");
  putArchive(where, a);
  const file = join(outDir(), "all.taskwright.zip");

  const exported = run(["data", "export", "--data", where.dataDir, "--to", file]);
  assert.equal(exported.status, 0, exported.err);
  assert.match(exported.out, /^数据包已经写好：.*all\.taskwright\.zip（\d+ 个文件，/);
  assert.match(exported.out, new RegExp(`任务 ${a}「甲」：\\d+ 个文件\\n`));
  assert.match(exported.out, /知识库 general「通用知识库」：0 个文件/);
  assert.deepEqual(readPack(file).manifest.tasks.map((t) => t.task_id).sort(), [a, b].sort());

  const target = fresh("target");
  const imported = run(["data", "import", "--data", target, "--from", file]);
  assert.equal(imported.status, 0, imported.err + imported.out);
  assert.match(imported.out, /^数据包导入报告（/);
  // 通用知识库两边都是空的：没有要导入的，照实写。
  assert.match(imported.out, /知识库 general「通用知识库」：没有导入（两边都是空的，没有要导入的）/);
  assert.match(imported.out, /合计：导入了 2 个任务、0 个知识库；因为已经存在而跳过 1 项；没有做成 0 项。/);
  assert.match(imported.out, /这份报告也写在 .*logs.import-\d{8}-\d{6}\.txt/);
  assert.deepEqual(registered(target)?.sort(), [[a, "甲", a], [b, "乙", b]].sort(), "导入时建出了任务登记");
  assert.deepEqual(tree(join(target, "runs", a)), tree(join(where.runsDir, a)));
  assert.deepEqual(facts(join(target, "tasks", a)), facts(join(where.tasksDir, a)));

  const again = run(["data", "import", "--data", target, "--from", file]);
  assert.equal(again.status, 0, "因为已经存在而跳过不算没有做成");
  assert.match(again.out, /合计：导入了 0 个任务、0 个知识库；因为已经存在而跳过 3 项；没有做成 0 项。/);
  assert.deepEqual(readdirSync(join(target, "tasks")).sort(), [a, b].sort());

  const renumbered = run(["data", "import", "--data", target, "--from", file, "--renumber"]);
  assert.equal(renumbered.status, 0, renumbered.err + renumbered.out);
  assert.match(renumbered.out, new RegExp(`任务 ${a}「甲」：已导入，编号改成了 TASK-\\d{8}-[0-9A-F]{4}（原来的编号已经有任务在用）`));
  assert.equal(readdirSync(join(target, "tasks")).length, 4);
  assert.equal(registered(target)?.length, 4);
});

test("导出：一个任务、一个知识库；没有这个编号、目标文件已经在、参数不对时退出 2；有任务目录没有带时退出 1", async () => {
  const where = await dataWith(fresh("data"), ["甲"]);
  const [a] = where.ids;
  const dir = outDir();
  const one = run(["data", "export", "--data", where.dataDir, "--task", a, "--to", join(dir, "one.zip")]);
  assert.equal(one.status, 0, one.err);
  assert.deepEqual([readPack(join(dir, "one.zip")).manifest.scope, readPack(join(dir, "one.zip")).manifest.libraries], ["task", []]);
  const lib = run(["data", "export", "--data", where.dataDir, "--library", "general", "--to", join(dir, "lib.zip")]);
  assert.equal(lib.status, 0, lib.err);
  assert.deepEqual(readPack(join(dir, "lib.zip")).manifest.scope, "library");

  const none = run(["data", "export", "--data", where.dataDir, "--task", "TASK-NOPE", "--to", join(dir, "none.zip")]);
  assert.deepEqual([none.status, none.err.trim()], [2, "没有导出：没有任务 TASK-NOPE。"]);
  const taken = run(["data", "export", "--data", where.dataDir, "--to", join(dir, "one.zip")]);
  assert.equal(taken.status, 2);
  assert.match(taken.err, /没有导出：文件 .*one\.zip 已经在了，没有覆盖它。/);
  for (const args of [["--data", where.dataDir], ["--data", where.dataDir, "--task", a, "--library", "general", "--to", join(dir, "x.zip")], ["--to", join(dir, "y.zip"), "--port", "1"]]) {
    const bad = run(["data", "export", ...args]);
    assert.equal(bad.status, 2, args.join(" "));
    assert.match(bad.err, /用法：taskwright data upgrade \[--data <数据目录>\][^]*taskwright data export \[--data <数据目录>\]/);
  }
  assert.deepEqual(readdirSync(dir).sort(), ["lib.zip", "one.zip"]);

  put(join(where.tasksDir, "broken", DB_NAME), "这不是一个数据库");
  const partial = run(["data", "export", "--data", where.dataDir, "--to", join(dir, "partial.zip")]);
  assert.equal(partial.status, 1, partial.err);
  assert.match(partial.out, /没有带：任务目录 broken（读不出任务编号，没有带）/);
});

test("导入：数据目录被服务占着、里面有上一版的数据要先升级、数据包不对时退出 2，什么都不动；缺 --from 给出用法", async () => {
  const where = await dataWith(fresh("data"), ["甲"]);
  const [a] = where.ids;
  const file = join(outDir(), "one.taskwright.zip");
  assert.equal(run(["data", "export", "--data", where.dataDir, "--task", a, "--to", file]).status, 0);

  // 目标数据目录里有一个任务正被一个活着的服务占着（用本测试进程当那个服务）。
  const busy = await dataWith(fresh("busy"), ["在用的"]);
  writeFileSync(join(busy.tasksDir, busy.ids[0], LOCK_NAME), JSON.stringify({ port: 8950, pid: process.pid, host: hostname(), mode: "server" }), "utf-8");
  const occupied = run(["data", "import", "--data", busy.dataDir, "--from", file]);
  assert.equal(occupied.status, 2, occupied.out);
  assert.match(occupied.err, /有服务正在使用数据目录 .*，所以没有导入。请先停下它，或者在页面上导入：\n  任务 /);
  assert.deepEqual(readdirSync(busy.tasksDir), [busy.ids[0]]);

  // 目标数据目录里有上一版留下的任务还没有升级。
  const old = fresh("old");
  mkdirSync(join(old, "tasks"), { recursive: true });
  cpSync(join(SAMPLES, "0.4.3"), join(old, "tasks", "TASK-OLD"), { recursive: true });
  const pending = run(["data", "import", "--data", old, "--from", file]);
  assert.equal(pending.status, 2, pending.out);
  assert.match(pending.err, /里有上一版留下的数据要先升级。请先运行 taskwright data upgrade --data .*，做完再导入。/);
  assert.deepEqual(readdirSync(join(old, "tasks")), ["TASK-OLD"]);

  // 数据包不对：一个不是数据包的文件；一个被改过内容的包。目标里不留下任务登记，也不留下任务。
  const target = fresh("target");
  const text = join(outDir(), "text.zip");
  writeFileSync(text, "这只是一段文字".repeat(20));
  const notPack = run(["data", "import", "--data", target, "--from", text]);
  assert.equal(notPack.status, 2, notPack.err);
  assert.match(notPack.out, /没有导入：这个文件不是数据包，或者已经损坏/);
  const tampered = join(outDir(), "tampered.zip");
  await repack(file, tampered, (_, contents) => contents.set(`tasks/${a}/task.json`, Buffer.from(contents.get(`tasks/${a}/task.json`)!.toString("utf-8").replace("local", "other"))));
  const wrong = run(["data", "import", "--data", target, "--from", tampered]);
  assert.equal(wrong.status, 2, wrong.err);
  assert.match(wrong.out, /没有导入：数据包里的文件 tasks\/.*task\.json 与清单文件记的校验值不符。整个包没有导入。/);
  assert.deepEqual([existsSync(join(target, SERVICE_DB_NAME)), readdirSync(join(target, "tasks"))], [false, []]);

  const usage = run(["data", "import", "--data", target]);
  assert.equal(usage.status, 2);
  assert.match(usage.err, /导入要写 --from <数据包>。\n用法：/);
});

test("数据包升级：旧包升成新包并能导入；参数不对、比这个程序新的包退出 2", async () => {
  const old = fresh("old");
  mkdirSync(join(old, "tasks"), { recursive: true });
  for (const version of ["0.4.0", "0.4.3"]) cpSync(join(SAMPLES, version), join(old, "tasks", version), { recursive: true });
  const dir = outDir();
  const pack = join(dir, "old.taskwright.zip");
  // 还没有升级的数据目录也能导出。
  assert.equal(run(["data", "export", "--data", old, "--to", pack]).status, 0);
  assert.deepEqual(readPack(pack).manifest.tasks.map((t) => t.task_db_version), [0, 0]);
  const before = readFileSync(pack);

  const to = join(dir, "new.taskwright.zip");
  const upgraded = run(["data", "upgrade", "--pack", pack, "--to", to]);
  assert.equal(upgraded.status, 0, upgraded.err + upgraded.out);
  assert.match(upgraded.out, new RegExp(`^数据包升级（原来的包由 .* 导出）\\n任务 TASK-SAMPLE-040「图书借阅（样本）」：格式 0 升到 ${TASK_DB_VERSION}，成功\\n任务 TASK-SAMPLE-043`));
  assert.match(upgraded.out, /数据包已经写好：.*new\.taskwright\.zip/);
  assert.deepEqual(readPack(to).manifest.tasks.map((t) => [t.task_id, t.task_db_version]), [["TASK-SAMPLE-040", TASK_DB_VERSION], ["TASK-SAMPLE-043", TASK_DB_VERSION]]);
  assert.deepEqual(readFileSync(pack), before, "原来的包原样");
  assert.equal(existsSync(join(old, SERVICE_DB_NAME)), false, "数据包升级不碰任何数据目录");

  const target = fresh("target");
  const imported = run(["data", "import", "--data", target, "--from", to]);
  assert.equal(imported.status, 0, imported.err + imported.out);
  assert.deepEqual(readdirSync(join(target, "tasks")).sort(), ["TASK-SAMPLE-040", "TASK-SAMPLE-043"]);
  assert.deepEqual(facts(join(target, "tasks", "TASK-SAMPLE-043")).version, TASK_DB_VERSION);

  for (const args of [["--pack", pack], ["--to", join(dir, "x.zip")], ["--pack", pack, "--to", join(dir, "x.zip"), "--data", old]]) {
    const bad = run(["data", "upgrade", ...args]);
    assert.equal(bad.status, 2, args.join(" "));
    assert.match(bad.err, /用法：taskwright data upgrade/);
  }
  const taken = run(["data", "upgrade", "--pack", pack, "--to", to]);
  assert.equal(taken.status, 2);
  assert.match(taken.err, /数据包没有升级：文件 .*new\.taskwright\.zip 已经在了/);
  const newer = join(dir, "newer.zip");
  await repack(to, newer, (manifest) => Object.assign(manifest, { pack_format: 99, product_version: "0.9.0" }));
  const refused = run(["data", "upgrade", "--pack", newer, "--to", join(dir, "y.zip")]);
  assert.equal(refused.status, 2);
  assert.match(refused.err, /数据包没有升级：这个数据包比这个程序新。这份数据由 0\.9\.0 写入，请用 0\.9\.0 或更新的版本打开。/);
  assert.deepEqual(readdirSync(dir).sort(), ["new.taskwright.zip", "newer.zip", "old.taskwright.zip"]);
});
