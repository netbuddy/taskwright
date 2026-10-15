/**
 * 数据升级的两条入口：
 * - 启动时：服务器形态发现有上一版留下的数据就不启动，说明先运行哪条命令；桌面形态先起来、不碰任何任务，等人点「开始升级」，
 *   做完接上任务登记、任务就能用了。
 * - 命令行 data upgrade：不起服务，备份、升级、打印报告；有服务正在用这个数据目录时不做；一个任务没有做成不挡别的；退出码各是几。
 * 旧任务用仓里格式 8 的样本任务目录（tests/fixtures/task_dirs/），复制到临时的数据目录里再用。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { DB_NAME } from "../../agent/src/lib/db.ts";
import { TASK_DB_VERSION } from "../../agent/src/lib/schema.ts";
import * as library from "../src/library.ts";
import { LOCK_NAME } from "../src/occupancy.ts";
import { SERVICE_DB_NAME } from "../src/service_db.ts";
import { upgradeCommandLine } from "../src/data_upgrade.ts";
import { StartError, startService } from "../src/start.ts";
import { BACKEND_MAIN, ROOT, captureConsole, tempDir } from "./helpers.ts";

captureConsole();

const SAMPLES = join(ROOT, "backend", "tests", "fixtures", "task_dirs");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

/** 一个新的数据目录，里面按「目录名: 样本名」放几个上一版的任务（格式 8 的样本）。 */
function dataWith(tasks: Record<string, string>): string {
  const data = join(tmp, `data-${++n}`);
  mkdirSync(join(data, "tasks"), { recursive: true });
  for (const [name, version] of Object.entries(tasks)) cpSync(join(SAMPLES, version), join(data, "tasks", name), { recursive: true });
  return data;
}

const version = (data: string, name: string) => library.taskDbVersion(join(data, "tasks", name));

/** 运行后端外壳（真进程），等它结束。 */
function run(args: string[]) {
  const done = spawnSync(process.execPath, [BACKEND_MAIN, ...args], { encoding: "utf-8", timeout: 60000 });
  return { status: done.status, out: done.stdout, err: done.stderr };
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

test("服务器形态：有上一版留下的任务就不启动，说明先运行哪条命令；什么都没有被改", async () => {
  const data = dataWith({ "TASK-A": "format-8-a", "TASK-B": "format-8-b" });
  await assert.rejects(startService({ port: 0, mode: "server", host: "127.0.0.1", profile: "fake", ownProcess: false, data }),
    (error: Error) => error instanceof StartError
      && error.message === `数据目录 ${data} 里有上一版留下的数据要先升级（2 个任务）。请先运行 taskwright data upgrade --data ${data}，做完再启动服务。`);
  assert.deepEqual([version(data, "TASK-A"), version(data, "TASK-B"), existsSync(join(data, SERVICE_DB_NAME)), existsSync(join(data, "backups"))], [8, 8, false, false]);
  // 真进程：退出码 1，标准错误里是同一句话。
  const real = run(["--data", data, "--port", "0", "--mode", "server", "--host", "127.0.0.1", "--profile", "fake"]);
  assert.equal(real.status, 1, real.err);
  assert.match(real.err, /服务没有起来：数据目录 .* 里有上一版留下的数据要先升级（2 个任务）。请先运行 taskwright data upgrade --data /);
});

test("任务目录不在数据目录下面时，提示里的命令带着 --tasks（知识库目录同理）；照提示运行确实升级了那些任务", async () => {
  // 拼命令的函数：缺省位置只带 --data；另给的目录各带自己的参数；带空白的路径加引号。
  assert.equal(upgradeCommandLine({ dataDir: "/d", tasksDir: "/d/tasks", knowledgeDir: "/d/knowledge" }), "taskwright data upgrade --data /d");
  assert.equal(upgradeCommandLine({ dataDir: "/d", tasksDir: "/d/tasks/", knowledgeDir: null }), "taskwright data upgrade --data /d");
  assert.equal(upgradeCommandLine({ dataDir: "/d", tasksDir: "/elsewhere/tasks", knowledgeDir: "/k b" }), 'taskwright data upgrade --data /d --tasks /elsewhere/tasks --knowledge "/k b"');
  // 真的服务：任务放在数据目录之外，启动被拒，提示里的命令带着 --tasks。
  const source = dataWith({ "TASK-A": "format-8-a" });
  const data = join(tmp, "data-apart");
  const tasks = join(tmp, "tasks-apart");
  mkdirSync(data, { recursive: true });
  cpSync(join(source, "tasks"), tasks, { recursive: true });
  await assert.rejects(startService({ port: 0, mode: "server", host: "127.0.0.1", profile: "fake", ownProcess: false, data, tasks }),
    (error: Error) => error instanceof StartError
      && error.message === `数据目录 ${data} 里有上一版留下的数据要先升级（1 个任务）。请先运行 taskwright data upgrade --data ${data} --tasks ${tasks}，做完再启动服务。`);
  // 只带 --data 的旧命令在这里是空跑；照提示带上 --tasks 才升级，报告写明扫的是哪个任务目录。
  const bare = run(["data", "upgrade", "--data", data]);
  assert.match(bare.out, new RegExp(`任务目录：${join(data, "tasks")}\n[\\s\\S]*任务：没有要升级的`));
  const done = run(["data", "upgrade", "--data", data, "--tasks", tasks]);
  assert.equal(done.status, 0, done.err);
  assert.ok(done.out.includes(`\n任务目录：${tasks}\n`), done.out);
  assert.match(done.out, /合计：1 个任务，成功 1 个，没有做成 0 个。/);
});

test("命令行 data upgrade：不起服务，备份、升级、打印报告；之后服务器形态起得来，任务能用", async () => {
  const data = dataWith({ "TASK-A": "format-8-a", "TASK-B": "format-8-b" });
  const done = run(["data", "upgrade", "--data", data]);
  assert.equal(done.status, 0, done.err);
  assert.match(done.out, /^数据升级报告（/);
  assert.match(done.out, new RegExp(`任务 TASK-SAMPLE-8A「图书借阅（样本甲）」：格式 8 升到 ${TASK_DB_VERSION}，成功`));
  assert.match(done.out, /合计：2 个任务，成功 2 个，没有做成 0 个。/);
  assert.match(done.out, /这份报告也写在 .*logs\/upgrade-\d{8}-\d{6}\.txt\n$/);
  assert.deepEqual([version(data, "TASK-A"), version(data, "TASK-B")], [TASK_DB_VERSION, TASK_DB_VERSION]);
  const [backup] = readdirSync(join(data, "backups"));
  assert.match(backup, /^\d{8}-\d{6}-pre-0\.5$/);
  assert.deepEqual(readdirSync(join(data, "backups", backup, "tasks")).sort(), ["TASK-A", "TASK-B"]);
  assert.equal(library.taskDbVersion(join(data, "backups", backup, "tasks", "TASK-A")), 8);
  const [report] = readdirSync(join(data, "logs")).filter((name) => name.startsWith("upgrade-"));
  assert.match(readFileSync(join(data, "logs", report), "utf-8"), /合计：2 个任务，成功 2 个/);
  // 再运行一次：没有要升级的，退出码仍是 0。
  const again = run(["data", "upgrade", "--data", data]);
  assert.deepEqual([again.status, /任务：没有要升级的/.test(again.out)], [0, true]);
  const started = await startService({ port: 0, mode: "server", host: "127.0.0.1", profile: "fake", ownProcess: false, data });
  try {
    assert.equal(started.service.upgrade, null);
    assert.deepEqual(started.service.listTasks().map((t) => [t.task_id, t.supported]).sort(), [["TASK-SAMPLE-8A", true], ["TASK-SAMPLE-8B", true]]);
  } finally {
    await started.stop();
  }
});

test("命令行 data upgrade：有服务正在用这个数据目录时不做，退出码 2；一个任务没有做成不挡别的，退出码 1，下一次还会再试它", () => {
  const data = dataWith({ "TASK-A": "format-8-b", "TASK-B": "format-8-b" });
  const lock = join(data, "tasks", "TASK-B", LOCK_NAME);
  writeFileSync(lock, JSON.stringify({ port: 8950, pid: process.pid, host: hostname(), mode: "server" }), "utf-8");
  const busy = run(["data", "upgrade", "--data", data]);
  assert.equal(busy.status, 2, busy.out);
  assert.match(busy.err, /有服务正在使用数据目录 .*，所以没有升级。请先停下它：\n  任务 TASK-B：/);
  assert.deepEqual([version(data, "TASK-A"), existsSync(join(data, "backups")), existsSync(join(data, SERVICE_DB_NAME))], [8, false, false], "一样都没有动");
  rmSync(lock);
  // 把一个任务库弄成升不了的样子（没有工具拒绝表，8 升 9 那一步给它加列加不成）。
  const db = new DatabaseSync(join(data, "tasks", "TASK-B", DB_NAME));
  db.exec("DROP TABLE tool_rejection");
  db.close();
  const partial = run(["data", "upgrade", "--data", data]);
  assert.equal(partial.status, 1, partial.err);
  assert.match(partial.out, /合计：2 个任务，成功 1 个，没有做成 1 个。/);
  assert.match(partial.out, /没有升级成（.*no such table: tool_rejection/);
  assert.deepEqual([version(data, "TASK-A"), version(data, "TASK-B")], [TASK_DB_VERSION, 8]);
  const retry = run(["data", "upgrade", "--data", data]);
  assert.equal(retry.status, 1);
  assert.match(retry.out, /合计：1 个任务，成功 0 个，没有做成 1 个。/, "命令行每次都再试记着失败的任务");
});

test("命令行：data 后面不是认得的命令、或者带了不认识的参数，退出码 2 并给出用法；起服务的参数照旧检查", () => {
  for (const args of [["data"], ["data", "restore"], ["data", "upgrade", "--port", "1"]]) {
    const done = run(args);
    assert.equal(done.status, 2, args.join(" "));
    assert.match(done.err, /用法：taskwright data upgrade \[--data <数据目录>\]/);
  }
  assert.match(run(["--tasks", join(tmp, "x")]).err, /缺少参数：--port。/);
});

test("桌面形态：有上一版留下的任务时先起来但不碰任何任务；开始升级之后一项一项做，做完接上任务登记，任务能用", async () => {
  const data = dataWith({ "TASK-A": "format-8-a", "TASK-B": "format-8-b" });
  const started = await startService({ port: 0, mode: "desktop", host: "127.0.0.1", profile: "fake", ownProcess: false, data });
  try {
    const { service } = started;
    const upgrade = service.upgrade!;
    assert.ok(upgrade, "等着升级");
    assert.deepEqual([upgrade.blocking, upgrade.state, service.registry], [true, "pending", null]);
    const before = upgrade.view();
    assert.deepEqual([before.state, before.data_dir, before.backup_dir, before.tasks, before.progress, before.report],
      ["pending", data, join(data, "backups"), [{ task_id: "TASK-SAMPLE-8A", name: "图书借阅（样本甲）" }, { task_id: "TASK-SAMPLE-8B", name: "图书借阅（样本乙）" }], null, null]);
    assert.deepEqual(service.listTasks(), [], "升级做完之前不扫描任务");
    assert.equal(existsSync(join(data, "tasks", "TASK-A", LOCK_NAME)), false, "也不占用它们");
    assert.deepEqual([version(data, "TASK-A"), existsSync(join(data, SERVICE_DB_NAME))], [8, false]);

    assert.equal(upgrade.start(), true);
    assert.equal(upgrade.start(), false, "正在做的时候再点不重复做");
    for (const end = Date.now() + 20000; upgrade.state === "running";) {
      if (Date.now() > end) throw new Error("升级没有做完");
      await sleep(20);
    }
    const after = upgrade.view();
    assert.deepEqual([after.state, upgrade.blocking, after.report?.fatal, after.report?.succeeded, after.report?.failed], ["done", false, null, 2, 0]);
    assert.deepEqual(after.progress, { total: 4, done: 4, current: null });
    assert.match(after.report!.text, /合计：2 个任务，成功 2 个，没有做成 0 个。/);
    assert.ok(service.registry, "任务登记接上了");
    assert.deepEqual(service.listTasks().map((t) => [t.task_id, t.supported]).sort(), [["TASK-SAMPLE-8A", true], ["TASK-SAMPLE-8B", true]]);
    assert.equal(upgrade.start(), false, "做完之后不再做");
  } finally {
    await started.stop();
  }
});

test("桌面形态：整体没有做成（备份不成）时仍然等着，任务都没有动；毛病去掉之后再点一次就做成", async () => {
  const data = dataWith({ "TASK-A": "format-8-b" });
  writeFileSync(join(data, "backups"), "这里本该是一个目录", "utf-8");
  const started = await startService({ port: 0, mode: "desktop", host: "127.0.0.1", profile: "fake", ownProcess: false, data });
  try {
    const upgrade = started.service.upgrade!;
    upgrade.start();
    for (const end = Date.now() + 20000; upgrade.state === "running";) {
      if (Date.now() > end) throw new Error("升级没有结束");
      await sleep(20);
    }
    assert.deepEqual([upgrade.state, upgrade.blocking, version(data, "TASK-A"), started.service.registry], ["failed", true, 8, null]);
    assert.match(upgrade.view().report!.fatal!, /^升级之前的备份没有做成，所以没有升级：/);
    assert.deepEqual(started.service.listTasks(), []);
    rmSync(join(data, "backups"));
    assert.equal(upgrade.start(), true, "可以再试");
    for (const end = Date.now() + 20000; upgrade.state === "running";) {
      if (Date.now() > end) throw new Error("升级没有结束");
      await sleep(20);
    }
    assert.deepEqual([upgrade.state, version(data, "TASK-A")], ["done", TASK_DB_VERSION]);
  } finally {
    await started.stop();
  }
});

test("全新的数据目录、或者只有现在格式的任务：两种形态都直接启动，不等升级", async () => {
  for (const mode of ["server", "desktop"] as const) {
    const data = join(tmp, `fresh-${mode}`);
    const started = await startService({ port: 0, mode, host: "127.0.0.1", profile: "fake", ownProcess: false, data });
    try {
      assert.equal(started.service.upgrade, null);
      assert.ok(existsSync(join(data, SERVICE_DB_NAME)), "任务登记直接建出来");
      started.service.create({ task_type: "requirements-engineering", task_name: "新任务" });
    } finally {
      await started.stop();
    }
    const again = await startService({ port: 0, mode, host: "127.0.0.1", profile: "fake", ownProcess: false, data });
    try {
      assert.deepEqual([again.service.upgrade, again.service.listTasks().map((t) => t.task_name)], [null, ["新任务"]]);
    } finally {
      await again.stop();
    }
  }
});
