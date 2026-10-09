/**
 * 数据升级经接口：桌面形态有上一版留下的任务时，服务信息里 upgrade_pending 为真，别的接口一律答 503 upgrade_pending；
 * 升级的两个接口看得到要升级什么、点了开始之后的进度与做完的报告；做完之后放开，任务列表读得出来。
 * 没有要做的升级时这两个接口的表现；从别的电脑打开页面也能开始升级。
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { UPGRADE_PENDING_TEXT, dispatch } from "../src/http.ts";
import { startService } from "../src/start.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";

captureConsole();

const SAMPLES = join(ROOT, "backend", "tests", "fixtures", "task_dirs");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

type Dict = Record<string, any>;
async function http(port: number, method: string, path: string): Promise<{ status: number; body: Dict }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return { status: res.status, body: (await res.json()) as Dict };
}

test("桌面形态：待升级时只有服务信息、升级与退出几个接口可用；开始之后看得到进度，做完有报告，别的接口放开", async () => {
  const data = join(tmp, "desktop");
  mkdirSync(join(data, "tasks"), { recursive: true });
  cpSync(join(SAMPLES, "0.4.1"), join(data, "tasks", "TASK-A"), { recursive: true });
  cpSync(join(SAMPLES, "0.4.3"), join(data, "tasks", "TASK-B"), { recursive: true });
  const started = await startService({ port: 0, mode: "desktop", host: "127.0.0.1", profile: "fake", ownProcess: false, data });
  try {
    const { port } = started;
    const info = await http(port, "GET", "/api/v1/service");
    assert.deepEqual([info.status, info.body.upgrade_pending, info.body.mode], [200, true, "desktop"]);
    for (const [method, path] of [["GET", "/api/v1/tasks"], ["POST", "/api/v1/tasks"], ["GET", "/api/v1/task-types"], ["GET", "/api/v1/knowledge"], ["GET", "/api/v1/model-config"]]) {
      const refused = await http(port, method, path);
      assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.message], [503, "upgrade_pending", UPGRADE_PENDING_TEXT], `${method} ${path}`);
    }
    const before = (await http(port, "GET", "/api/v1/service/upgrade")).body.upgrade;
    assert.deepEqual([before.state, before.data_dir, before.backup_dir, before.tasks.map((t: Dict) => t.task_id), before.service, before.knowledge, before.progress, before.report],
      ["pending", data, join(data, "backups"), ["TASK-SAMPLE-041", "TASK-SAMPLE-043"], false, false, null, null]);

    const begun = await http(port, "POST", "/api/v1/service/upgrade");
    assert.deepEqual([begun.status, begun.body.started, begun.body.upgrade.state], [200, true, "running"]);
    assert.deepEqual([begun.body.upgrade.progress.total, begun.body.upgrade.progress.done], [4, 0]);
    let view: Dict = begun.body.upgrade;
    const seen = new Set<number>();
    for (const end = Date.now() + 20000; view.state === "running";) {
      if (Date.now() > end) throw new Error("升级没有做完");
      await sleep(10);
      view = (await http(port, "GET", "/api/v1/service/upgrade")).body.upgrade;
      if (view.progress) seen.add(view.progress.done);
    }
    assert.deepEqual([view.state, view.progress, view.report.fatal, view.report.succeeded, view.report.failed], ["done", { total: 4, done: 4, current: null }, null, 2, 0]);
    assert.match(view.report.text, /^数据升级报告（[\s\S]*升级之前的备份：.*backups[\s\S]*合计：2 个任务，成功 2 个，没有做成 0 个。\n$/);
    assert.ok([...seen].every((n) => n >= 0 && n <= 4));
    // 做完：放开。
    assert.equal((await http(port, "GET", "/api/v1/service")).body.upgrade_pending, false);
    const tasks = await http(port, "GET", "/api/v1/tasks");
    assert.deepEqual([tasks.status, tasks.body.tasks.map((t: Dict) => [t.task_id, t.supported]).sort()], [200, [["TASK-SAMPLE-041", true], ["TASK-SAMPLE-043", true]]]);
    const again = await http(port, "POST", "/api/v1/service/upgrade");
    assert.deepEqual([again.status, again.body.started, again.body.upgrade.state], [200, false, "done"], "做完之后再点不重复做，报告还看得到");
  } finally {
    await started.stop();
  }
});

test("从别的电脑打开页面也能开始升级：开始升级的接口不限来源（退出服务仍然只接受本机来的请求）", async () => {
  const data = join(tmp, "remote");
  mkdirSync(join(data, "tasks"), { recursive: true });
  cpSync(join(SAMPLES, "0.4.2"), join(data, "tasks", "TASK-A"), { recursive: true });
  const started = await startService({ port: 0, mode: "desktop", host: "127.0.0.1", profile: "fake", ownProcess: false, data });
  try {
    // 经分发函数直接验，来源写成别的电脑。
    const from = (method: string, path: string) => dispatch(started.service, { method, path, query: {}, headers: {}, body: Buffer.alloc(0), remote: "192.0.2.7" }) as Promise<Dict>;
    const body = (reply: Dict) => JSON.parse(reply.body.toString("utf-8"));
    const exit = await from("POST", "/api/v1/service/exit");
    assert.deepEqual([exit.status, body(exit).error.code], [403, "forbidden"]);
    const begun = await from("POST", "/api/v1/service/upgrade");
    assert.deepEqual([begun.status, body(begun).started, body(begun).upgrade.state], [200, true, "running"]);
    for (const end = Date.now() + 20000; started.service.upgrade!.state === "running";) {
      if (Date.now() > end) throw new Error("升级没有做完");
      await sleep(10);
    }
    assert.deepEqual([started.service.upgrade!.state, started.service.upgrade!.report?.succeeded], ["done", 1]);
  } finally {
    await started.stop();
  }
});

test("没有要做的升级：服务信息里 upgrade_pending 为假，看升级的接口给 null，开始升级被拒，别的接口照常", async () => {
  const data = join(tmp, "plain");
  const started = await startService({ port: 0, mode: "desktop", host: "127.0.0.1", profile: "fake", ownProcess: false, data });
  try {
    const { port } = started;
    assert.equal((await http(port, "GET", "/api/v1/service")).body.upgrade_pending, false);
    assert.deepEqual((await http(port, "GET", "/api/v1/service/upgrade")).body, { ok: true, upgrade: null });
    const refused = await http(port, "POST", "/api/v1/service/upgrade");
    assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.message], [422, "rejected", "现在没有要做的数据升级。"]);
    assert.deepEqual((await http(port, "GET", "/api/v1/tasks")).body, { ok: true, tasks: [] });
  } finally {
    await started.stop();
  }
});
