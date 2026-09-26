/**
 * 服务层：建任务（起始文件、pi 项目设置、失败时整体清理、任务目录里没有指向自己的绝对路径）；上传材料的规则（类型、5 MB、
 * 重名加序号、投影保留名、路径越界）；Word 材料的投影、原样取回与 content 给投影；旧格式任务照样列出；占用标记的写入、
 * 拒绝、覆盖、删除；任务类型；用户直接操作的修订写成一句操作名。
 * 对应服务端 Python 测试 test_service_units（材料与旧格式两条）、test_new_workspace、test_isolation（占用锁部分与绝对路径）、
 * test_docx_material（读取与上传部分）。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { makeServer } from "../src/http.ts";
import * as occupancy from "../src/occupancy.ts";
import { ProjectionError, projectionPath, projectionText, writeProjection } from "../src/projection.ts";
import { Service, taskTypes, userActionText } from "../src/service.ts";
import { CreateTaskError, createTaskDir, newWorkspace } from "../src/workspace.ts";
import { ROOT, sqlGet, tempDir } from "./helpers.ts";

const SAMPLE = join(ROOT, "examples", "library-lending", "requirements-styled.docx");
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let tmp: string;
before(() => { tmp = tempDir(); });
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const fresh = () => join(tmp, `case-${++n}`);
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  return null;
};

function newService(port: number | null = null, root = fresh()) {
  return new Service(join(root, "tasks"), join(root, "runs"), {}, { port });
}

// ───────────── 建任务 ─────────────

describe("建任务目录：起始文件原样复制，没带 pi 项目设置时写一份排队模式为 all 的", () => {
  let source: string;
  before(() => {
    source = join(tmp, "start");
    mkdirSync(join(source, "docs"), { recursive: true });
    writeFileSync(join(source, "docs", "a.md"), "甲", "utf-8");
    writeFileSync(join(source, "README.md"), "给人看的", "utf-8");
  });

  test("起始文件没带时写一份；顶层 README.md 不复制；有 inputs/", async () => {
    const path = newWorkspace(join(tmp, "ws1"), source);
    assert.deepEqual(JSON.parse(readFileSync(join(path, ".pi", "settings.json"), "utf-8")), { followUpMode: "all" });
    assert.equal(existsSync(join(path, "README.md")), false);
    assert.ok(statSync(join(path, "inputs")).isDirectory());
    assert.equal(readFileSync(join(path, "docs", "a.md"), "utf-8"), "甲");
  });

  test("起始文件带了就照它复制", async () => {
    mkdirSync(join(source, ".pi"), { recursive: true });
    writeFileSync(join(source, ".pi", "settings.json"), '{"followUpMode": "all", "x": 1}', "utf-8");
    const path = newWorkspace(join(tmp, "ws2"), source);
    assert.deepEqual(JSON.parse(readFileSync(join(path, ".pi", "settings.json"), "utf-8")), { followUpMode: "all", x: 1 });
    rmSync(join(source, ".pi"), { recursive: true });
  });
});

test("建任务：同进程调用 agent 的 createTask，发起方记用户、编号是操作编号；任务名为空时取任务定义里的名字", async () => {
  const service = newService();
  try {
    const { task_id: taskId } = service.create({ task_type: "srs-authoring", task_name: "  ", domain_tag: " 电商 " });
    const dir = service.task(taskId).dir;
    const row = sqlGet(dir, "SELECT task_id, task_name, domain_tag, session_id, call_id FROM task")!;
    assert.deepEqual([row.task_id, row.task_name, row.domain_tag, row.session_id], [taskId, null, "电商", ""]);
    assert.match(row.call_id, /^ui-op-[0-9a-f]{12}$/);
    assert.equal(sqlGet(dir, "SELECT actor FROM event")!.actor, "user");
    assert.equal(service.taskPage(service.task(taskId)).task_name, "软件需求规格说明编制");
    assert.equal(codeOf(() => service.create({ task_type: "no-such" })), "bad_request");
  } finally {
    await service.close();
  }
});

describe("建任务失败时整体清理", () => {
  const saved = process.env.TASKWRIGHT_TASKS_ROOT;
  afterEach(() => {
    if (saved === undefined) delete process.env.TASKWRIGHT_TASKS_ROOT;
    else process.env.TASKWRIGHT_TASKS_ROOT = saved;
  });

  test("写任务记录被拒：这次建的目录整个删掉；原来就有的空目录只清空里面", async () => {
    // 任务根目录设成别处：写库前的核对不通过，任务记录写不成。
    process.env.TASKWRIGHT_TASKS_ROOT = join(tmp, "somewhere-else");
    const target = join(fresh(), "TASK-X");
    assert.throws(() => createTaskDir(target), (e: unknown) => e instanceof CreateTaskError && /任务记录没有写成：.*拒绝写入/.test(e.message));
    assert.equal(existsSync(target), false);
    const empty = join(fresh(), "TASK-Y");
    mkdirSync(empty, { recursive: true });
    assert.throws(() => createTaskDir(empty), CreateTaskError);
    assert.deepEqual(readdirSync(empty), []);
  });

  test("服务层把失败写成 rejected，data.reasons 带原因，任务目录里不留东西", async () => {
    process.env.TASKWRIGHT_TASKS_ROOT = join(tmp, "somewhere-else");
    const service = newService();
    try {
      assert.throws(() => service.create({}), (e: unknown) => e instanceof ApiError && e.code === "rejected" && e.message === "任务没有创建成功。" &&
        Array.isArray(e.data.reasons) && /任务记录没有写成/.test(String((e.data.reasons as string[])[0])));
      assert.deepEqual(readdirSync(service.tasksDir), []);
    } finally {
      await service.close();
    }
  });

  test("目标目录已经有东西时不建", async () => {
    const busy = fresh();
    mkdirSync(busy, { recursive: true });
    writeFileSync(join(busy, "x"), "x");
    assert.throws(() => createTaskDir(busy), (e: unknown) => e instanceof CreateTaskError && /已经存在而且不是空的/.test(e.message));
    assert.deepEqual(readdirSync(busy), ["x"]);
  });
});

test("任务目录里没有指向它自己绝对路径的东西", async () => {
  const root = fresh();
  const service = newService(8861, root);
  let dir: string;
  try {
    dir = service.task(service.create({ task_type: "srs-authoring", task_name: "路径盘点" }).task_id).dir;
  } finally {
    await service.close();
  }
  const needles = [dir!, resolve(dir!), root];
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const file of walk(dir!)) {
    const text = readFileSync(file).toString("latin1");
    const found = needles.filter((one) => text.includes(Buffer.from(one, "utf-8").toString("latin1")));
    assert.deepEqual(found, [], `${file} 里出现了绝对路径`);
  }
});

test("任务类型：task-types 下每个目录，显示名取任务定义里的任务名", async () => {
  assert.deepEqual(taskTypes(), [{ task_type: "srs-authoring", name: "软件需求规格说明编制" }]);
});

// ───────────── 材料 ─────────────

test("上传材料：只收三种文本，重名加序号，超过 5 MB 拒绝，路径越界拒绝；任务页列出材料", async () => {
  const service = newService();
  try {
    const t = service.task(service.create({ task_type: "srs-authoring", task_name: "材料测试" }).task_id);
    assert.deepEqual(service.upload(t, "需求.md", Buffer.from("甲")), { ok: true, path: "inputs/需求.md" });
    assert.equal(service.upload(t, "需求.md", Buffer.from("乙")).path, "inputs/需求-2.md");
    for (const [name, code] of [["图.png", "unsupported_type"], ["a/b.md", "bad_request"], ["a\\b.md", "bad_request"], ["", "bad_request"], ["x.DOCX.txt", "bad_request"], ["x.docx.MD", "bad_request"]]) {
      assert.equal(codeOf(() => service.upload(t, name, Buffer.from("x"))), code, name);
    }
    assert.equal(codeOf(() => service.upload(t, "大.txt", Buffer.alloc(5 * 1024 * 1024 + 1, 0x78))), "too_large");
    assert.equal(readFileSync(service.materialPath(t, "inputs/需求-2.md"), "utf-8"), "乙");
    for (const bad of ["inputs/../task.sqlite", "docs/task-definitions/srs-authoring.json", "/etc/passwd", ""]) {
      assert.equal(codeOf(() => service.materialPath(t, bad)), "bad_request", bad);
    }
    const page = service.taskPage(t);
    assert.deepEqual(page.materials.map((m) => m.path), ["inputs/需求-2.md", "inputs/需求.md"]);
    assert.deepEqual([page.task_name, page.sessions], ["材料测试", []]);
  } finally {
    await service.close();
  }
});

describe("Word 材料", () => {
  test("投影：在同一进程里调用 agent 的投影函数，写投影与图片目录；不是 docx 时抛错；找投影先 .md 后 .txt", () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    const docx = join(dir, "x.docx");
    writeFileSync(docx, readFileSync(SAMPLE));
    assert.equal(writeProjection(docx, "inputs/x.docx"), join(dir, "x.docx.md"));
    const text = readFileSync(join(dir, "x.docx.md"), "utf-8");
    assert.ok(text.startsWith("<!--\n由 x.docx 生成，供助手阅读。段落总数：114。"));
    assert.ok(text.includes("\n### 3.1.1 [p75] 逾期罚款\n"));
    assert.ok(existsSync(join(dir, "x.docx.media", "image1.png")));
    assert.equal(projectionText(docx, "inputs/x.docx"), text);
    const bad = join(dir, "坏.docx");
    writeFileSync(bad, "not a zip");
    assert.throws(() => writeProjection(bad, "inputs/坏.docx"), (e: unknown) => e instanceof ProjectionError && e.message === "不是 Word 文件（.docx），或者文件已损坏");
    const other = join(dir, "y.docx");
    assert.equal(projectionPath(other), other + ".md");
    writeFileSync(other + ".txt", "[第 1 段] 旧");
    assert.equal(projectionPath(other), other + ".txt");
    writeFileSync(other + ".md", "[p1] 新");
    assert.equal(projectionPath(other), other + ".md");
  });

  test("上传 docx：旁边生成投影与图片目录，重名时跟着新名字；材料清单标明派生自哪份 Word 文件", async () => {
    const service = newService();
    try {
      const t = service.task(service.create({ task_type: "srs-authoring", task_name: "Word 材料" }).task_id);
      assert.deepEqual(service.upload(t, "需求.docx", readFileSync(SAMPLE)), { ok: true, path: "inputs/需求.docx" });
      const projection = readFileSync(join(t.dir, "inputs", "需求.docx.md"), "utf-8");
      assert.ok(projection.startsWith("<!--\n由 需求.docx 生成"));
      assert.ok(projection.includes("出处写 inputs/需求.docx#p段落号"));
      assert.ok(projection.includes("![图 1](inputs/需求.docx.media/image1.png)"));
      assert.ok(existsSync(join(t.dir, "inputs", "需求.docx.media", "image1.png")));
      assert.equal(service.upload(t, "需求.docx", readFileSync(SAMPLE)).path, "inputs/需求-2.docx");
      assert.ok(readFileSync(join(t.dir, "inputs", "需求-2.docx.md"), "utf-8").includes("![图 1](inputs/需求-2.docx.media/image1.png)"));
      assert.ok(existsSync(join(t.dir, "inputs", "需求-2.docx.media", "image2.png")));
      const listing = () => service.taskPage(t).materials;
      assert.deepEqual(listing().map((m) => m.path), ["inputs/需求-2.docx", "inputs/需求-2.docx.md", "inputs/需求.docx", "inputs/需求.docx.md"], "图片目录不列");
      assert.deepEqual(Object.fromEntries(listing().map((m) => [m.path, m.derived_from])), {
        "inputs/需求-2.docx": null, "inputs/需求-2.docx.md": "inputs/需求-2.docx", "inputs/需求.docx": null, "inputs/需求.docx.md": "inputs/需求.docx" });
      writeFileSync(join(t.dir, "inputs", "需求.docx.txt"), "[第 1 段] 旧", "utf-8");
      writeFileSync(join(t.dir, "inputs", "孤儿.docx.md"), "x", "utf-8");
      const marks = Object.fromEntries(listing().map((m) => [m.path, m.derived_from]));
      assert.deepEqual([marks["inputs/需求.docx.txt"], marks["inputs/孤儿.docx.md"]], ["inputs/需求.docx", null], "0.2 的 .txt 投影同样标明；没有对应 .docx 的 .md 是普通材料");
    } finally {
      await service.close();
    }
  });

  test("坏的 docx 与保留名拒绝；坏文件连同投影都不留下", async () => {
    const service = newService();
    try {
      const t = service.task(service.create({ task_type: "srs-authoring", task_name: "Word 材料" }).task_id);
      for (const [name, code] of [["坏.docx", "unsupported_type"], ["a.docx.txt", "bad_request"], ["a.docx.md", "bad_request"], ["图.png", "unsupported_type"]]) {
        assert.equal(codeOf(() => service.upload(t, name, Buffer.from("x"))), code, name);
      }
      assert.deepEqual(readdirSync(join(t.dir, "inputs")), []);
    } finally {
      await service.close();
    }
  });

  test("原样取回端点给内容类型与原字节，路径越界拒绝；content 端点对 docx 给投影，只有 0.2 的 .txt 时给它，都没有时现算不写文件", async () => {
    const service = newService();
    const t = service.task(service.create({ task_type: "srs-authoring", task_name: "取回" }).task_id);
    service.upload(t, "需求.docx", readFileSync(SAMPLE));
    service.upload(t, "说明.md", Buffer.from("甲"));
    const server = makeServer(service).listen(0, "127.0.0.1");
    await new Promise((ok) => server.once("listening", ok));
    const port = (server.address() as AddressInfo).port;
    const get = (what: string, rel: string) => new Promise<{ status: number; type: string; body: Buffer }>((ok, fail) => {
      request(`http://127.0.0.1:${port}/api/v1/tasks/${t.taskId}/materials/${what}?path=${encodeURIComponent(rel)}`, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode!, type: String(res.headers["content-type"]), body: Buffer.concat(chunks) }));
      }).on("error", fail).end();
    });
    const content = async () => JSON.parse((await get("content", "inputs/需求.docx")).body.toString("utf-8")).text as string;
    try {
      const raw = await get("raw", "inputs/需求.docx");
      assert.equal(raw.type, DOCX_TYPE);
      assert.ok(raw.body.equals(readFileSync(SAMPLE)));
      const md = await get("raw", "inputs/说明.md");
      assert.deepEqual([md.type, md.body.toString("utf-8")], ["text/markdown; charset=utf-8", "甲"]);
      for (const [bad, status] of [["inputs/../task.sqlite", 400], ["/etc/passwd", 400], ["", 400], ["inputs/没有.docx", 404]] as const) {
        assert.equal((await get("raw", bad)).status, status, bad);
      }
      assert.ok((await content()).includes("\n[p76] 逾期的每本每天罚款一角，罚款最多不超过这本书的定价。罚款怎样缴纳待定。\n"));
      renameSync(join(t.dir, "inputs", "需求.docx.md"), join(t.dir, "inputs", "需求.docx.txt"));
      assert.equal(await content(), readFileSync(join(t.dir, "inputs", "需求.docx.txt"), "utf-8"));
      rmSync(join(t.dir, "inputs", "需求.docx.txt"));
      assert.ok((await content()).includes("\n[p76] 逾期的每本每天罚款一角"));
      assert.equal(existsSync(join(t.dir, "inputs", "需求.docx.md")), false);
    } finally {
      server.close();
      await service.close();
    }
  });
});

// ───────────── 任务列表里的两种打不开的任务 ─────────────

test("修订统一之前建的任务照样列出，标明不支持且打不开", async () => {
  const root = fresh();
  const old = join(root, "tasks", "TASK-OLD");
  mkdirSync(old, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(old, "task.sqlite"));
  db.exec("CREATE TABLE task (task_id TEXT); INSERT INTO task VALUES ('TASK-OLD'); CREATE TABLE item_version (task_id TEXT, item_id TEXT, version_no INTEGER, revision_no INTEGER);");
  db.close();
  const service = newService(null, root);
  const rows = service.listTasks();
  assert.deepEqual(rows.map((r) => [r.task_id, r.status, r.supported]), [["TASK-OLD", "旧格式", false]]);
  assert.match(String(rows[0].note), /这个任务是旧格式/);
  assert.equal(codeOf(() => service.task("TASK-OLD")), "not_found");
  assert.equal(existsSync(join(old, occupancy.LOCK_NAME)), false, "旧格式的任务不接手，也不写占用标记");
});

describe("占用标记", () => {
  test("接手时写占用标记，退出时删掉", async () => {
    const service = newService(8861);
    const folder = service.task(service.create({ task_type: "srs-authoring", task_name: "占用测试" }).task_id).dir;
    const lock = JSON.parse(readFileSync(join(folder, occupancy.LOCK_NAME), "utf-8"));
    assert.deepEqual([lock.port, lock.pid, lock.host], [8861, process.pid, hostname()]);
    assert.ok("started_at" in lock);
    assert.match(readFileSync(join(folder, occupancy.LOCK_NAME), "utf-8"), /^\{"port": 8861, "pid": \d+, "started_at": "[^"]+", "host": "[^"]+", "mode": "server"\}\n$/, "文件写法与 Python 版相同，另加运行形态一项");
    await service.close();
    assert.equal(existsSync(join(folder, occupancy.LOCK_NAME)), false);
  });

  test("别的活着的服务占用时拒绝服务，列表写明被谁占用；那个服务退出后遗留标记被覆盖", async () => {
    const root = fresh();
    const first = newService(8861, root);
    const taskId = first.create({ task_type: "srs-authoring", task_name: "被占用的任务" }).task_id;
    const folder = first.task(taskId).dir;
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    try {
      writeFileSync(join(folder, occupancy.LOCK_NAME), JSON.stringify({ port: 8790, pid: other.pid, started_at: "2026-09-24T10:00:00", host: hostname() }), "utf-8");
      const second = new Service(join(root, "tasks"), join(root, "runs2"), {}, { port: 8862 });
      const row = second.listTasks().find((r) => r.task_id === taskId)!;
      assert.deepEqual([row.status, row.supported, row.task_name], ["占用中", false, "被占用的任务"]);
      assert.equal((row.occupied as any).port, 8790);
      assert.equal(row.note, "这个任务正被端口 8790 的服务占用，这里不能打开。");
      assert.throws(() => second.task(taskId), (e: unknown) => e instanceof ApiError && e.code === "task_occupied" && e.status === 409);
      assert.equal(JSON.parse(readFileSync(join(folder, occupancy.LOCK_NAME), "utf-8")).pid, other.pid, "别人的标记不动");
      await second.close();
      assert.ok(existsSync(join(folder, occupancy.LOCK_NAME)), "没有接手的任务，退出时不删别人的标记");
    } finally {
      other.kill();
      await new Promise((ok) => other.once("exit", ok));
    }
    const third = new Service(join(root, "tasks"), join(root, "runs3"), {}, { port: 8863 });
    try {
      assert.equal(third.task(taskId).taskId, taskId);
      assert.equal(JSON.parse(readFileSync(join(folder, occupancy.LOCK_NAME), "utf-8")).port, 8863);
    } finally {
      await third.close();
      first.tasks.clear();
    }
  });

  test("另一台主机写的标记当作占用", async () => {
    const folder = fresh();
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, occupancy.LOCK_NAME), JSON.stringify({ port: 9000, pid: 1, host: "另一台主机" }), "utf-8");
    const taken = occupancy.claim(folder, 8861)!;
    assert.equal(taken.host, "另一台主机");
    assert.ok(occupancy.occupiedText(taken).includes("（主机 另一台主机）"));
  });
});

test("用户直接操作的修订写成一句操作名", async () => {
  const edit = { operations: [{ op: "update", item_id: "UC-002", fields_changed: ["基本流程", "前置条件"] }], undo_of_revision: null };
  assert.equal(userActionText("edit_fields", edit), "你改了 UC-002 的「基本流程」「前置条件」");
  assert.equal(userActionText("keep_pending", { operations: [{ op: "update", item_id: "TBD-003", fields_changed: ["状态"] }] }), "你把 TBD-003 标为先不管");
  assert.equal(userActionText("delete_item", { operations: [{ op: "delete", item_id: "UC-004", fields_changed: [] }] }), "你删除了 UC-004");
  assert.equal(userActionText(null, { operations: [], undo_of_revision: 4 }), "你撤销了修订 4");
  assert.equal(userActionText(null, { operations: [{ op: "update", item_id: "UC-001", fields_changed: ["名称"] }] }), "你改了 UC-001 的「名称」", "会话记录里找不到操作种类时按修订里的操作写");
});
