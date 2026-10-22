/**
 * 保存图按工作阶段守门（lib/save_diagram.ts 调 lib/stage.ts）：助手在核读材料与澄清两个阶段不能画图、改图、删图，
 * 整理建模起可以。用户在页面上改图不看阶段；早先建的任务没有阶段。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTask } from "../src/lib/create_task.ts";
import { type SaveDiagramParams, saveDiagram } from "../src/lib/save_diagram.ts";
import { STAGE_NAMES } from "../src/lib/stage.ts";
import { withTaskDatabase } from "../src/lib/schema.ts";
import { launchWorkItem } from "../src/lib/stage_read.ts";
import { rejectionOf } from "../src/lib/tool_rejection.ts";
import { DIAGRAM_OP_KIND, editDiagram } from "../src/lib/user_diagram.ts";
import { DEFINITION_PATH, callIn, count, demoDefinition, enterStage, makeWorkspace, overallDefinition, query } from "./helpers.ts";

const USER_SAID = "把借书的过程画成一张流程图";
const MERMAID = "flowchart LR\n  a([读者选书]) --> b([办借书手续])";
const fresh = (over: Partial<SaveDiagramParams> = {}): SaveDiagramParams =>
  ({ name: "借书的过程", kind: "flowchart", mermaid: MERMAID, sources: [{ kind: "用户的话", excerpt: USER_SAID }], ...over });
const save = (dir: string, params: SaveDiagramParams) =>
  saveDiagram({ ...callIn(dir), userMessages: [{ entryId: "u1", text: `${USER_SAID}。` }] }, params, { validate: async () => ({ ok: true }) });
/** 保存图被拒时的两层文字；没有被拒返回 null。 */
async function refusal(dir: string, params: SaveDiagramParams): Promise<{ fact: string; guidance: string; message: string } | null> {
  try {
    await save(dir, params);
    return null;
  } catch (error) {
    const layers = rejectionOf(error);
    assert.ok(layers, String(error));
    return { fact: layers.fact, guidance: layers.guidance, message: (error as Error).message };
  }
}
function workspace(definition: unknown = overallDefinition()): string {
  const dir = makeWorkspace(definition);
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  return dir;
}
const revisionOf = (dir: string) => query<{ n: number }>(dir, "SELECT MAX(revision_no) AS n FROM diagram_version WHERE diagram_id = 'D-001'")[0].n;

test("核读材料与澄清两个阶段：新画、修改、删除都被拦，原话写明现在在哪个阶段、要先做什么", async () => {
  const dir = workspace();
  // 需求分析从核读材料启动。
  enterStage(dir, "reading");
  const reading = (await refusal(dir, fresh()))!;
  assert.equal(reading.fact, "任务现在在核读材料阶段，这个阶段不能画图、改图或删图");
  assert.equal(reading.guidance, "图要到整理建模阶段才能画。往前进入下一段要由用户在卡片上点，你只能提议：材料读完之后先提议进入澄清，" +
    "请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 next_step「进入下一步：澄清」、stay「继续本步」；澄清告一段落之后，再照同样的办法提议「进入下一步：整理建模」");
  assert.equal(reading.message, `这张图没有保存：${reading.fact}。\n怎么办：${reading.guidance}。`);
  enterStage(dir, "clarifying");
  const clarifying = (await refusal(dir, fresh()))!;
  assert.equal(clarifying.fact, "任务现在在澄清阶段，这个阶段不能画图、改图或删图");
  assert.equal(clarifying.guidance, "图要到整理建模阶段才能画。进入整理建模要由用户在卡片上选「进入下一步：整理建模」，你只能提议：澄清告一段落之后，" +
    "请用请选择卡片提议，说清下一段要做什么，两个选项的键与文字是 next_step「进入下一步：整理建模」、stay「继续本步」");
  assert.equal(count(dir, "diagram"), 0);

  // 在整理建模阶段画好一张，再退回澄清：改与删也被拦。
  enterStage(dir, "modeling");
  assert.equal(await refusal(dir, fresh()), null);
  enterStage(dir, "clarifying");
  assert.match((await refusal(dir, { diagram: "D-001", base_revision: 1, note: "加一句说明。" }))!.fact, /^任务现在在澄清阶段，这个阶段不能画图、改图或删图$/);
  assert.match((await refusal(dir, { diagram: "D-001", base_revision: 1, delete: true }))!.fact, /^任务现在在澄清阶段/);
  assert.equal(revisionOf(dir), 1, "图还是修订 1");
});

test("整理建模、写条目、评审确认三个阶段：新画、修改、删除都可以", async () => {
  const dir = workspace();
  for (const stage of ["modeling", "writing", "reviewing"] as const) {
    enterStage(dir, stage);
    const name = `借书的过程（${STAGE_NAMES[stage]}）`;
    const saved = await save(dir, fresh({ name }));
    const id = (saved.details as { diagram_id: string }).diagram_id;
    assert.equal(await refusal(dir, { diagram: id, base_revision: 1, note: "改了说明。" }), null, STAGE_NAMES[stage]);
    assert.equal(await refusal(dir, { diagram: id, base_revision: 2, delete: true }), null, STAGE_NAMES[stage]);
  }
  assert.equal(count(dir, "diagram"), 3);
});

test("用户在页面上改图不看阶段：澄清阶段照样能改", async () => {
  const dir = workspace();
  enterStage(dir, "modeling");
  await save(dir, fresh());
  enterStage(dir, "clarifying");
  const edited = await editDiagram({ workspaceDir: dir, sessionId: "sess-ui" },
    { op_id: "ui-op-1", kind: DIAGRAM_OP_KIND, targets: [{ diagram_id: "D-001", base_revision: 1 }], fields: { mermaid: `${MERMAID}\n  b --> c([离馆])` } });
  assert.deepEqual(edited.results, [{ diagram_id: "D-001", revision_no: 2 }]);
});

test("早先建的任务没有阶段：有材料也不拦，助手照旧直接画图", async () => {
  const dir = workspace(demoDefinition());
  assert.equal(await refusal(dir, fresh()), null);
  assert.equal(count(dir, "activity_record"), 0);
});

test("逆向解析的工作项：获准写入按当前活动取，逆向解析不能画图（它的获准写入是页、问题、条目），原话按它算作的阶段写核读材料", async () => {
  const dir = makeWorkspace(overallDefinition(), { material: true });
  createTask(callIn(dir), { definition_path: DEFINITION_PATH });
  withTaskDatabase(dir, { createIfMissing: false }, (db) => {
    const task = db.prepare("SELECT task_id FROM task LIMIT 1").get() as { task_id: string };
    launchWorkItem(db, { taskId: task.task_id, sessionId: "session-test", runId: null, callId: "ui-op-parse", actor: "user", to: "parse_spec", flow: "reengineering", reason: "" });
  });
  const got = await refusal(dir, fresh());
  assert.ok(got && got.fact.includes(`任务现在在${STAGE_NAMES.reading}阶段`), JSON.stringify(got));
  assert.equal(count(dir, "diagram"), 0);
});
