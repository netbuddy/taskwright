/**
 * 版本记录的两个接口（GET …/versions 与 GET …/versions/{n}/document）、任务状况里的 versions，与库事件 version_published。
 * 版本记录由发布写（agent/src/lib/versions.ts 的 recordVersion）；后端测试不导入写入函数，这里直接往库里放几行，存档文件直接写进任务目录。
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { UPGRADED_VERSION_NOTE } from "../../agent/src/lib/schema.ts";
import { dispatch } from "../src/http.ts";
import * as library from "../src/library.ts";
import { Service } from "../src/service.ts";
import { taskStatus } from "../src/task_status.ts";
import { captureConsole, sqlGet, sqlRun, tempDir } from "./helpers.ts";

captureConsole();

let tmp: string;
let service: Service;
before(() => {
  tmp = tempDir();
  service = new Service(join(tmp, "tasks"), join(tmp, "runs"), {});
});
after(async () => {
  await service.close();
  rmSync(tmp, { recursive: true, force: true });
});

const get = async (path: string, query: Record<string, string> = {}) =>
  (await dispatch(service, { method: "GET", path, query, headers: {}, body: Buffer.alloc(0) })) as { status: number; headers: Record<string, string>; body: Buffer };
const json = async (path: string, query: Record<string, string> = {}) => {
  const reply = await get(path, query);
  return { status: reply.status, body: JSON.parse(reply.body.toString("utf-8")) };
};

/** 建一个任务，放三版：第 1 版是升级补的（没有存档），第 2 版两种存档都在，第 3 版记着 Word 存档而文件已经不在。 */
function taskWithVersions(): { taskId: string; dir: string } {
  const { task_id: taskId } = service.create({});
  const dir = service.task(taskId).dir;
  mkdirSync(join(dir, "versions", "v2"), { recursive: true });
  writeFileSync(join(dir, "versions", "v2", "document.md"), "# 第 2 版\n", "utf-8");
  writeFileSync(join(dir, "versions", "v2", "document.docx"), Buffer.from("PK-word"));
  const insert = "INSERT INTO version_record (version_no, task_id, published_at, actor, revision_no, note, markdown_path, docx_path, figure_count, figure_pictures, event_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
  sqlRun(dir, [
    [insert, 1, taskId, "2026-10-01T11:00:00", "user", 2, UPGRADED_VERSION_NOTE, null, null, null, null, 1],
    [insert, 2, taskId, "2026-10-12T09:30:00", "user", 9, "加了预约", "versions/v2/document.md", "versions/v2/document.docx", 2, 2, 1],
    [insert, 3, taskId, "2026-10-13T09:30:00", "executor", 12, null, "versions/v2/document.md", "versions/v3/document.docx", 3, 0, 1],
  ]);
  return { taskId, dir };
}

test("版本清单：按版本号从小到大，写发布的时刻、谁、修订号、说明、文档里有几张图与其中几张是图片，以及两种存档在不在（文件还在任务目录里才算）；任务状况里的 versions 相同", async () => {
  const { taskId, dir } = taskWithVersions();
  const reply = await json(`/api/v1/tasks/${taskId}/versions`);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.versions.map((one: Record<string, unknown>) => [one.version_no, one.actor, one.revision_no, one.note, one.figure_count, one.figure_pictures, one.has_markdown, one.has_docx]), [
    [1, "user", 2, UPGRADED_VERSION_NOTE, null, null, false, false],
    [2, "user", 9, "加了预约", 2, 2, true, true],
    [3, "executor", 12, null, 3, 0, true, false],
  ]);
  assert.match(reply.body.versions[1].published_at, /^2026-10-12T09:30:00/);
  assert.deepEqual(taskStatus(dir)!.versions, reply.body.versions);
  // 资产六格里「文档与版本」一格随之写发布到第几版。
  assert.deepEqual(taskStatus(dir)!.assets!.find((one) => one.key === "versions"), {
    key: "versions", name: "文档与版本", count: 3, unit: "版", text: "第 3 版", note: "", produced_by: ["编写文档", "发布"],
  });
});

test("下载某一版的存档：Markdown 与 Word 各给原样的文件和下载用的文件名；没有存档的版本、存档文件已经不在、没有这一版、format 写错时说明原因", async () => {
  const { taskId } = taskWithVersions();
  const md = await get(`/api/v1/tasks/${taskId}/versions/2/document`);
  assert.deepEqual([md.status, md.headers["Content-Type"], md.body.toString("utf-8")], [200, "text/markdown; charset=utf-8", "# 第 2 版\n"]);
  assert.match(md.headers["Content-Disposition"], new RegExp(`^attachment; filename="${taskId}-v2\\.md"; filename\\*=UTF-8''`));
  assert.match(decodeURIComponent(md.headers["Content-Disposition"].split("''")[1]), /-第2版\.md$/);
  const docx = await get(`/api/v1/tasks/${taskId}/versions/2/document`, { format: "docx" });
  assert.deepEqual([docx.status, docx.headers["Content-Type"], docx.body.toString("utf-8")],
    [200, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "PK-word"]);
  const upgraded = await json(`/api/v1/tasks/${taskId}/versions/1/document`, { format: "docx" });
  assert.deepEqual([upgraded.status, upgraded.body.error.message], [404, "第 1 版没有 Word 存档：这一版是升级之前完成的，当时的文档没有存下来。"]);
  const gone = await json(`/api/v1/tasks/${taskId}/versions/3/document`, { format: "docx" });
  assert.deepEqual([gone.status, gone.body.error.message], [404, "第 3 版的 Word 存档不在任务目录里了。"]);
  const none = await json(`/api/v1/tasks/${taskId}/versions/9/document`);
  assert.deepEqual([none.status, none.body.error.message], [404, "这个任务没有第 9 版。"]);
  const bad = await json(`/api/v1/tasks/${taskId}/versions/2/document`, { format: "pdf" });
  assert.deepEqual([bad.status, bad.body.error.message], [400, "format 要写 md 或 docx，不写是 md。"]);
});

test("库事件：VERSION_PUBLISHED 转成 version_published，带版本号、修订号、谁与发布说明", () => {
  const { taskId, dir } = taskWithVersions();
  const seq = Number(sqlGet(dir, "SELECT MAX(seq) AS seq FROM event")!.seq) + 1;
  sqlRun(dir, [["INSERT INTO event (seq, task_id, session_id, call_id, name, payload, actor, at) VALUES (?, ?, 's', 'ui-op-publish', 'VERSION_PUBLISHED', ?, 'user', '2026-10-13T10:00:00')",
    seq, taskId, JSON.stringify({ version_no: 4, revision_no: 13, actor: "user", note: "第四版" })]]);
  const [events] = library.libraryEvents(dir, seq - 1);
  const published = events.filter(([name]) => name === "version_published").map(([, one]) => [one.version_no, one.revision_no, one.actor, one.note, one.op_id]);
  assert.deepEqual(published, [[4, 13, "user", "第四版", "ui-op-publish"]]);
});
