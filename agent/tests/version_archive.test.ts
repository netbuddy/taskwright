/**
 * 助手发布版本时请任务服务写存档（lib/version_archive.ts）：发到存档接口的是版本号与修订号，拿回两个文件的位置与图存了没有；
 * 任务目录里没有服务锁、服务回答了错误、到时间没有回答时，都按「这一版不发布、请用户在页面上再试」拒绝。
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers.ts";
import { LOCK_NAME } from "../src/lib/knowledge_search.ts";
import { ToolRejection } from "../src/lib/tool_rejection.ts";
import { archivePath, archiveWithService } from "../src/lib/version_archive.ts";

const CHECK = { taskId: "TASK-1", versionNo: 2, revisionNo: 7, conditions: 3 };

function taskDir(): string {
  const dir = tempDir("version-archive-");
  writeFileSync(join(dir, LOCK_NAME), JSON.stringify({ port: 8999, host: "0.0.0.0" }));
  return dir;
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("发到存档接口的是版本号与修订号；拿回两个文件的位置与图存了没有", async () => {
  const sent: { url: string; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return reply(200, { ok: true, markdown_path: "versions/v2/document.md", docx_path: "versions/v2/document.docx", figures_archived: false });
  }) as unknown as typeof globalThis.fetch;
  const archive = await archiveWithService(taskDir(), CHECK, { fetch });
  assert.deepEqual(sent, [{ url: "http://127.0.0.1:8999" + archivePath("TASK-1"), body: { version_no: 2, revision_no: 7 } }]);
  assert.equal(archivePath("TASK-1"), "/api/v1/tasks/TASK-1/versions/archive");
  assert.deepEqual(archive, { markdownPath: "versions/v2/document.md", docxPath: "versions/v2/document.docx", figuresArchived: false });
});

test("没有服务锁、服务回答了错误、到时间没有回答：这一版不发布，拒绝里写明原因与请用户在页面上再试", async () => {
  const refused = async (dir: string, fetch: typeof globalThis.fetch | undefined, timeoutMs?: number) => {
    try {
      await archiveWithService(dir, CHECK, { fetch, timeoutMs });
    } catch (error) {
      assert.ok(error instanceof ToolRejection);
      return (error as ToolRejection).message;
    }
    assert.fail("应当拒绝");
  };
  const noLock = await refused(tempDir("version-archive-"), undefined);
  assert.match(noLock, /^第 2 版没有发布：这一版的文档没有存下来（联系不上任务服务）。/);
  assert.match(noLock, /请用户稍后在页面上点「发布版本」再试。$/);
  const wrong = await refused(taskDir(), (async () => reply(422, { ok: false, error: { code: "rejected", message: "第 2 版已经发布过了。" } })) as unknown as typeof globalThis.fetch);
  assert.match(wrong, /（任务服务回答了错误：第 2 版已经发布过了。）/);
  const slow = (async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
  })) as unknown as typeof globalThis.fetch;
  assert.match(await refused(taskDir(), slow, 50), /（等了很久没有等到任务服务写好）/);
});
