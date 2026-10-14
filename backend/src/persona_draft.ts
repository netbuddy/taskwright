/**
 * 把一个任务里用户说过的话整理成模拟器用户画像的草稿（调试模式的「导出为用户画像」）。
 *
 * 画像文件的形状照 sim/personas/ 下的文件：名字、说明、人设、目标、答不上的说法、材料、熟悉的材料、材料说明、隐藏事实、接受底线。
 * 草稿里只有「隐藏事实」与材料是从任务里整理出来的：用户自己打的每一句话是一条事实；用户在卡片上的每一次选择是一条事实，
 * 写成「问：……　答：……」。每条事实的关键词、必须同时出现、问到的迹象三项留空，由人补；人设、目标等也留空。
 * 不收的：系统替用户发的固定句（看过条目之后那一类、两个开头按钮发的两句、活动输入页启动之后发的每项活动一句）、进入或留在某个阶段的卡片选择（那是推进工作的决定，
 * 不是这件事本身的事实）。这里只整理，不读文件、不碰任务库；取各条会话的消息由调用方做。
 */

import { basename } from "node:path";
import { ACTIVITY_START_TEXTS, ENTER_OPTIONS, STAGE_START_TEXTS, STATUS_NEXT_TEXT, STAY_IDLE_OPTION, STAY_OPTIONS } from "../../agent/src/lib/stage.ts";

/** 一条会话的对话消息（conversation.ts 的 baseMessages 给的形状），按先后。 */
export type SessionMessages = Record<string, any>[];

const STAGE_KEYS = new Set([...Object.values(ENTER_OPTIONS), ...Object.values(STAY_OPTIONS), STAY_IDLE_OPTION].map((one) => one.key));
const START_TEXTS = new Set<string>([...Object.values(STAGE_START_TEXTS), ...Object.values(ACTIVITY_START_TEXTS), STATUS_NEXT_TEXT]);

export interface PersonaFact {
  事实: string;
  关键词: string[];
  必须同时出现: string[][];
  问到的迹象: string[];
}

const fact = (text: string): PersonaFact => ({ 事实: text, 关键词: [], 必须同时出现: [], 问到的迹象: [] });

/** 一条会话里用户说过的话与卡片选择，各成一条事实。 */
export function factsOfSession(messages: SessionMessages): PersonaFact[] {
  const replies = new Map<string, Record<string, any>>();
  const out: PersonaFact[] = [];
  for (const one of messages) {
    if (one.type === "assistant_reply" && one.message_id) replies.set(String(one.message_id), one);
    if (one.type !== "user_message") continue;
    const text = String(one.text ?? "").trim();
    if (!text) continue;
    if (one.origin === "typed") {
      if (!START_TEXTS.has(text)) out.push(fact(text));
    } else if (one.origin === "card_choice") {
      const note = (one.annotation ?? {}) as Record<string, any>;
      if (STAGE_KEYS.has(String(note.option_key ?? ""))) continue;
      const card = replies.get(String(note.reply_message_id ?? ""));
      const asked = String(card?.act?.text ?? "").trim();
      const answer = String(note.option_text ?? "").trim() || text;
      out.push(fact(asked ? `问：${asked}　答：${answer}` : answer));
    }
    // origin 为 ui_request 的是界面操作之后系统替用户发的固定句，不收。
  }
  return out;
}

/** 整份草稿。sessions 是各条会话的消息，按会话的先后；materials 是任务的材料路径（不含由别的材料生成的文件）。 */
export function personaDraft(task: { task_id: string; task_name: string }, materials: string[], sessions: SessionMessages[]) {
  const names = materials.map((path) => basename(path));
  const facts = sessions.flatMap(factsOfSession);
  return {
    名字: "",
    说明: `由任务「${task.task_name}」（${task.task_id}）导出的草稿：隐藏事实是这个任务里用户说过的 ${facts.length} 句话与卡片上的选择，照原话列出。` +
      "用它之前要补上名字、人设、目标，删掉不算事实的句子，并给每条事实补上关键词、必须同时出现与问到的迹象。",
    人设: "",
    目标: "",
    答不上的说法: [] as string[],
    材料: names,
    熟悉的材料: names,
    材料说明: "",
    隐藏事实: facts,
    接受底线: [] as unknown[],
  };
}
