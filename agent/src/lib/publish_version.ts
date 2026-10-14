/**
 * 「发布版本」的核心逻辑：只做事实核对——按任务定义的「完成条件」逐项调用 conditions.ts 里的核对函数（与看板、查询任务状态同一组函数），
 * 再核对用户同意了发布，都通过才记一个版本（lib/versions.ts 的 recordVersion：一行版本记录与一条 VERSION_PUBLISHED 事件）。
 * 不满足就拒绝，逐条说明缺什么。它不判断内容好坏。发布不改任务的任何别的东西：任务照常可以修改，以后再发布新的一版。
 *
 * 同意：一个版本发出去就留在版本记录里，所以要用户在「这个任务是否已经完成」的卡片上点过「已完成，发布版本」，
 * 或者在页面上点了「发布版本」并确认，而且点了之后交付物没有新的修订（lib/completion_consent.ts）。
 * 条件不满足时只报条件，不提同意，免得助手在条件还没满足时就去问用户。
 *
 * 文档存档：发布时生成的 Markdown 与 Word 存在任务目录的 versions/v{N}/ 下。生成文档的是任务服务，所以分两步：
 * 先核对（preparePublish，定下这一版的版本号 N 与修订号 R），由调用方请任务服务把这一版的文档写进 versions/vN/，
 * 再在一个事务里重新核对一遍、确认 N 与 R 没有变，记下版本（publishVersion）。助手的工具走 publishWithArchive 把两步接起来；
 * 页面发布时任务服务先写好存档，再经界面操作带着存档的位置调 publishVersion。
 *
 * 本模块不依赖 pi，单元测试可以直接调用。
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ACTOR_EXECUTOR, ACTOR_USER } from "./db.ts";
import { publishRefusal } from "./stage.ts";
import { stageOf } from "./stage_read.ts";
import { CONFIRM_CONDITION, checkCompletion, type ConditionResult, unreadItems, unreadList } from "./conditions.ts";
import { NoDatabaseYet, withTaskDatabase } from "./schema.ts";
import { validateDefinition } from "./definition.ts";
import { ToolRejection } from "./tool_rejection.ts";
import { AGREE_TEXT, COMPLETE_KEY, type CardClick, type Consent, DECLINE_TEXT, judgeConsent } from "./completion_consent.ts";
import { clickEventSeq } from "./dialogue_acts.ts";
import { type FigureTally, nextVersionNo, recordVersion, versionDir } from "./versions.ts";

export interface PublishCall {
  workspaceDir: string;
  sessionId: string;
  callId: string;
  /**
   * 用户的同意从哪里来：助手调用时是会话里最近一次对完成卡片的点击（lib/completion_consent.ts 的 lastCompletionClick），没有时为空；
   * 用户在页面上点「发布版本」并确认时是页面当时看到的修订号。
   */
  consent?: { source: "card"; click: CardClick } | { source: "page"; revisionNo: number } | null;
  /** 事件的发起方：助手调用时是执行者（缺省），页面上的发布是用户。 */
  actor?: string;
  /** 发布说明（可空）。 */
  note?: string | null;
}

/** 核对通过时定下的：这一版的版本号与发布时交付物的修订号，以及完成条件有几条。 */
export interface PublishCheck {
  taskId: string;
  versionNo: number;
  revisionNo: number;
  conditions: number;
}

/** 这一版的文档存档：两个文件相对任务目录的路径（没有存档为 null），与文档里有几张图、其中几张在 Word 里是图片（一张图都没有时为 null）。 */
export interface Archive {
  markdownPath: string | null;
  docxPath: string | null;
  figures: FigureTally | null;
}

/** 拒绝时给助手的指引：怎样问用户这个任务是否已经完成、可以发布了。 */
export const CONSENT_GUIDANCE =
  "请用回复的请选择（choose）问用户这个任务是否已经完成、可以发布了：问句照实写出事实与后果，例如「功能用例、非功能需求、约束一共 12 个条目，" +
  "都已经评审通过或者由你保留了写法，你也都看过了，没有未解决的问题。这个任务是否已经完成、可以发布第 1 版？发布之后仍然可以接着修改，以后再发布新的一版。」" +
  `（数字与事实照实填写）；两个选项是 { key: "${COMPLETE_KEY}", text: "${AGREE_TEXT}" } 与「${DECLINE_TEXT}」。` +
  `用户在卡片上点了「${AGREE_TEXT}」之后再调用「发布版本」；用户在对话里打字说要发布不算，照样先发卡片。`;

/** 卡片点击换成同意：点击之后那句话记进对话行为表时的事件序号，定下点的时候交付物是哪次修订。库里找不到那一行时为空。 */
function cardConsent(db: DatabaseSync, taskId: string, sessionId: string, click: CardClick): Consent | null {
  const seq = clickEventSeq(db, taskId, sessionId, click.userEntryId);
  if (seq === null) return null;
  const revisionNo = Number((db.prepare("SELECT COALESCE(MAX(revision_no), 0) AS n FROM revision WHERE task_id = ? AND event_seq < ?")
    .get(taskId, seq) as { n: number }).n);
  return { source: "card", agreed: click.optionKey === COMPLETE_KEY, revisionNo, optionText: click.optionText };
}

export interface PublishOutcome {
  text: string;
  details: { task_id: string; event_seq: number; version_no: number; revision_no: number };
}

function describe(r: ConditionResult): string {
  const items = (r.unmet ?? []).map((u) => u.item).filter(Boolean);
  return `「${r.collection}」${r.condition}：${r.summary}${items.length ? `还差 ${items.join("、")}。` : ""}`;
}

/** 在调用方开好的事务里核对能不能发布：阶段（只看助手）、完成条件、同意。通过时定下版本号与修订号，不写任何东西；不通过抛 ToolRejection。 */
function check(db: DatabaseSync, call: PublishCall): PublishCheck {
  const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; definition_text: string } | undefined;
  if (!task) throw new Error("库里还没有任务，没有可以发布的版本。");
  const definition = validateDefinition(JSON.parse(task.definition_text));
  const versionNo = nextVersionNo(db, task.task_id);
  const nope = `第 ${versionNo} 版没有发布`;
  // 工作的阶段（lib/stage.ts）：助手只有在评审确认与编写文档阶段才能发布，先于完成条件核对。用户在页面上发布不看阶段；早先建的任务没有阶段。
  if ((call.actor ?? ACTOR_EXECUTOR) !== ACTOR_USER) {
    const stage = stageOf(db, call.workspaceDir, task.task_id, definition, call.sessionId);
    const refusal = stage ? publishRefusal(stage) : null;
    if (refusal) {
      const fact = `${nope}：${refusal[0]}。`;
      throw new ToolRejection(`${fact}\n${refusal[1]}。`, fact, `${refusal[1]}。`);
    }
  }
  const results = checkCompletion(db, task.task_id, definition.completion, { workspaceDir: call.workspaceDir });
  const unmet = results.filter((r) => !r.satisfied);
  if (unmet.length) {
    // 未读的条目单独成一句，执行者可以原样转告用户；其余没满足的条件逐条列出。
    const unread = unreadItems(db, task.task_id, definition.completion,
      (name) => definition.collections.find((c) => c.name === name)?.fields[0]?.name);
    const others = unmet.filter((r) => r.condition !== CONFIRM_CONDITION);
    const fact = `${nope}。\n` +
      (unread.length ? `还有 ${unread.length} 条你从没看过：${unreadList(unread)}。\n` : "") +
      (others.length ? `另有 ${others.length} 条完成条件没有满足：\n${others.map((r, i) => `${i + 1}. ${describe(r)}`).join("\n")}\n` : "");
    const guidance = (unread.length ? "请把上面「还有 N 条你从没看过」那句原样告诉用户，请用户打开这几条看一眼；" : "请把缺的告诉用户；") +
      "补齐之后再调用「发布版本」。";
    throw new ToolRejection(fact + guidance, fact.trimEnd(), guidance);
  }
  const latest = Number((db.prepare("SELECT COALESCE(MAX(revision_no), 0) AS n FROM revision WHERE task_id = ?").get(task.task_id) as { n: number }).n);
  const consent = call.consent?.source === "card" ? cardConsent(db, task.task_id, call.sessionId, call.consent.click)
    : call.consent?.source === "page" ? { source: "page" as const, agreed: true, revisionNo: call.consent.revisionNo } : null;
  const verdict = judgeConsent(consent, latest);
  if (!verdict.ok && consent?.source === "page") {
    // 页面上的发布：同意就是这次点击，没同过意与点的是另一项都不会出现；只可能是页面看到的修订已经不是现在的。说明是给用户看的。
    const stale = verdict.reason === "stale" ? verdict : { revisionNo: consent.revisionNo, latest };
    const fact = `这次没有发布：你看到的是修订 ${stale.revisionNo}，交付物现在已经是修订 ${stale.latest}。请看过现在的内容再发布。`;
    throw new ToolRejection(fact, fact, "");
  }
  if (!verdict.ok) {
    const fact = `${nope}：` + (verdict.reason === "none"
      ? `用户还没有在问这个任务是否已经完成的卡片上点「${AGREE_TEXT}」。`
      : verdict.reason === "declined"
        ? `用户在最近一张问这个任务是否已经完成的卡片上选的是「${verdict.optionText ?? DECLINE_TEXT}」。`
        : `用户在修订 ${verdict.revisionNo} 时点了「${AGREE_TEXT}」，之后交付物又有了修订 ${verdict.latest}，要重新问。`);
    throw new ToolRejection(`${fact}\n${CONSENT_GUIDANCE}`, fact, CONSENT_GUIDANCE);
  }
  return { taskId: task.task_id, versionNo, revisionNo: latest, conditions: results.length };
}

function noDatabase(error: unknown): never {
  if (error instanceof NoDatabaseYet) throw new Error("这个任务目录还没有任务数据库，没有可以发布的版本。");
  throw error;
}

/** 第一步：核对能不能发布，定下版本号与修订号。不写库。 */
export function preparePublish(call: PublishCall): PublishCheck {
  try {
    return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => check(db, call));
  } catch (error) {
    return noDatabase(error);
  }
}

/**
 * 第二步：在一个事务里重新核对，记下版本。expect 是第一步定下的版本号与修订号：其间交付物又有了修订、或者别处先发布了这一版，
 * 就不记，照实说明（存档是按第一步的修订写的，对不上了）。不给 expect 时按这一次核对的结果记。
 */
export function publishVersion(call: PublishCall, archive: Archive, expect?: { versionNo: number; revisionNo: number }): PublishOutcome {
  try {
    return withTaskDatabase(call.workspaceDir, { createIfMissing: false }, (db) => {
      const now = check(db, call);
      if (expect && (now.versionNo !== expect.versionNo || now.revisionNo !== expect.revisionNo)) {
        const fact = now.versionNo !== expect.versionNo
          ? `这次没有发布：第 ${expect.versionNo} 版已经发布过了，请看过现在的版本再发布。`
          : `这次没有发布：存档是按修订 ${expect.revisionNo} 生成的，交付物现在已经是修订 ${now.revisionNo}。请看过现在的内容再发布。`;
        throw new ToolRejection(fact, fact, "");
      }
      const recorded = recordVersion(db, {
        taskId: now.taskId, sessionId: call.sessionId, callId: call.callId, actor: call.actor ?? ACTOR_EXECUTOR, revisionNo: now.revisionNo,
        note: call.note ?? null, versionNo: now.versionNo, markdownPath: archive.markdownPath, docxPath: archive.docxPath, figures: archive.figures,
      });
      const kept = archive.markdownPath && archive.docxPath ? "生成的文档存了 Markdown 与 Word 两份" : archive.markdownPath || archive.docxPath ? "生成的文档存了一份" : "这一版没有存文档";
      const text = `第 ${now.versionNo} 版已发布：完成条件 ${now.conditions} 条全部满足，发布的是修订 ${now.revisionNo}，${kept}。` +
        "发布之后任务照常可以修改，以后再发布新的一版。";
      return { text, details: { task_id: now.taskId, event_seq: recorded.event_seq, version_no: now.versionNo, revision_no: now.revisionNo } };
    });
  } catch (error) {
    return noDatabase(error);
  }
}

/** 文档存档没有做成时的拒绝（任务服务联系不上、生成出错）。why 是原因。 */
export function archiveRefusal(versionNo: number, why: string): ToolRejection {
  const fact = `第 ${versionNo} 版没有发布：这一版的文档没有存下来（${why}）。这是程序这边的问题，不是交付物有问题。`;
  const guidance = "请把这件事告诉用户，请用户稍后在页面上点「发布版本」再试。";
  return new ToolRejection(`${fact}\n${guidance}`, fact, guidance);
}

/**
 * 助手的工具用：核对、请任务服务写存档、再记下版本。存档写好之后没有记成（其间又有了修订之类）时把这一版的存档目录删掉，
 * 免得留下没有版本记录的文件。archiver 写不成时抛 ToolRejection（见 archiveRefusal）。
 */
export async function publishWithArchive(call: PublishCall, archiver: (check: PublishCheck) => Promise<Archive>): Promise<PublishOutcome> {
  const ready = preparePublish(call);
  const archive = await archiver(ready);
  try {
    return publishVersion(call, archive, { versionNo: ready.versionNo, revisionNo: ready.revisionNo });
  } catch (error) {
    const dir = join(call.workspaceDir, versionDir(ready.versionNo));
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
