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
import { fillText, refusalText } from "./texts.ts";
import { ToolRejection, notInputProblem } from "./tool_rejection.ts";
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
export const CONSENT_GUIDANCE = fillText("part.publish_consent_guidance", { key: COMPLETE_KEY, agree: AGREE_TEXT, decline: DECLINE_TEXT });

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
  return fillText("part.publish_condition", {
    collection: r.collection, condition: r.condition, summary: r.summary, missing: items.length ? fillText("part.publish_missing", { items: items.join("、") }) : "",
  });
}

/** 在调用方开好的事务里核对能不能发布：阶段（只看助手）、完成条件、同意。通过时定下版本号与修订号，不写任何东西；不通过抛 ToolRejection。 */
function check(db: DatabaseSync, call: PublishCall): PublishCheck {
  const task = db.prepare("SELECT task_id, definition_text FROM task ORDER BY started_at LIMIT 1").get() as { task_id: string; definition_text: string } | undefined;
  if (!task) throw notInputProblem(new Error(fillText("publish_version.no_task")));
  const definition = validateDefinition(JSON.parse(task.definition_text));
  const versionNo = nextVersionNo(db, task.task_id);
  // 工作的阶段（lib/stage.ts）：助手只有在评审确认与编写文档阶段才能发布，先于完成条件核对。用户在页面上发布不看阶段；早先建的任务没有阶段。
  if ((call.actor ?? ACTOR_EXECUTOR) !== ACTOR_USER) {
    const stage = stageOf(db, call.workspaceDir, task.task_id, definition, call.sessionId);
    const refusal = stage ? publishRefusal(stage) : null;
    if (refusal) {
      const fact = fillText("part.publish_not_published", { version: versionNo, fact: refusal.fact });
      throw new ToolRejection(`${fact}\n${refusal.guidance}。`, fact, `${refusal.guidance}。`, [refusal.code]);
    }
  }
  const results = checkCompletion(db, task.task_id, definition.completion, { workspaceDir: call.workspaceDir });
  const unmet = results.filter((r) => !r.satisfied);
  if (unmet.length) {
    // 未读的条目单独成一句，执行者可以原样转告用户；其余没满足的条件逐条列出。
    const unread = unreadItems(db, task.task_id, definition.completion,
      (name) => definition.collections.find((c) => c.name === name)?.fields[0]?.name);
    const others = unmet.filter((r) => r.condition !== CONFIRM_CONDITION);
    const fact = fillText("publish_version.completion_unmet", {
      version: versionNo,
      unread: unread.length ? `${fillText("part.publish_unread", { count: unread.length, list: unreadList(unread) })}\n` : "",
      others: others.length ? `${fillText("part.publish_others", { count: others.length, list: others.map((r, i) => `${i + 1}. ${describe(r)}`).join("\n") })}\n` : "",
    });
    const guidance = unread.length ? fillText("part.publish_unmet_guidance_unread") : fillText("part.publish_unmet_guidance");
    throw new ToolRejection(fact + guidance, fact.trimEnd(), guidance, ["publish_version.completion_unmet"]);
  }
  const latest = Number((db.prepare("SELECT COALESCE(MAX(revision_no), 0) AS n FROM revision WHERE task_id = ?").get(task.task_id) as { n: number }).n);
  const consent = call.consent?.source === "card" ? cardConsent(db, task.task_id, call.sessionId, call.consent.click)
    : call.consent?.source === "page" ? { source: "page" as const, agreed: true, revisionNo: call.consent.revisionNo } : null;
  const verdict = judgeConsent(consent, latest);
  if (!verdict.ok && consent?.source === "page") {
    // 页面上的发布：同意就是这次点击，没同过意与点的是另一项都不会出现；只可能是页面看到的修订已经不是现在的。说明是给用户看的。
    const stale = verdict.reason === "stale" ? verdict : { revisionNo: consent.revisionNo, latest };
    const fact = fillText("publish_version.page_revision_stale", { seen: stale.revisionNo, latest: stale.latest });
    throw new ToolRejection(fact, fact, "", ["publish_version.page_revision_stale"]);
  }
  if (!verdict.ok) {
    const [code, fact] = verdict.reason === "none"
      ? ["publish_version.consent_none", fillText("publish_version.consent_none", { version: versionNo, agree: AGREE_TEXT })]
      : verdict.reason === "declined"
        ? ["publish_version.consent_declined", fillText("publish_version.consent_declined", { version: versionNo, chosen: verdict.optionText ?? DECLINE_TEXT })]
        : ["publish_version.consent_stale", fillText("publish_version.consent_stale", { version: versionNo, agreed_at: verdict.revisionNo, agree: AGREE_TEXT, latest: verdict.latest })];
    throw new ToolRejection(`${fact}\n${CONSENT_GUIDANCE}`, fact, CONSENT_GUIDANCE, [code]);
  }
  return { taskId: task.task_id, versionNo, revisionNo: latest, conditions: results.length };
}

function noDatabase(error: unknown): never {
  if (error instanceof NoDatabaseYet) throw notInputProblem(new Error(fillText("publish_version.no_database")));
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
        const [code, fact] = now.versionNo !== expect.versionNo
          ? ["publish_version.version_already_published", fillText("publish_version.version_already_published", { version: expect.versionNo })]
          : ["publish_version.revision_moved_during_archive", fillText("publish_version.revision_moved_during_archive", { archived: expect.revisionNo, now: now.revisionNo })];
        throw new ToolRejection(fact, fact, "", [code]);
      }
      const recorded = recordVersion(db, {
        taskId: now.taskId, sessionId: call.sessionId, callId: call.callId, actor: call.actor ?? ACTOR_EXECUTOR, revisionNo: now.revisionNo,
        note: call.note ?? null, versionNo: now.versionNo, markdownPath: archive.markdownPath, docxPath: archive.docxPath, figures: archive.figures,
      });
      const kept = archive.markdownPath && archive.docxPath ? fillText("result.publish_version.kept_both")
        : archive.markdownPath || archive.docxPath ? fillText("result.publish_version.kept_one") : fillText("result.publish_version.kept_none");
      const text = fillText("result.publish_version.published", { version: now.versionNo, conditions: now.conditions, revision: now.revisionNo, kept });
      return { text, details: { task_id: now.taskId, event_seq: recorded.event_seq, version_no: now.versionNo, revision_no: now.revisionNo } };
    });
  } catch (error) {
    return noDatabase(error);
  }
}

/** 文档存档没有做成时的拒绝（任务服务联系不上、生成出错）。why 是原因。 */
export function archiveRefusal(versionNo: number, why: string): ToolRejection {
  const refusal = refusalText("publish_version.archive_failed", { version: versionNo, why });
  // 存档没有做成是程序这边的问题，不是输入的问题：不记进拒绝表。
  return notInputProblem(new ToolRejection(`${refusal.fact}\n${refusal.guidance}`, refusal.fact, refusal.guidance, [refusal.code]));
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
