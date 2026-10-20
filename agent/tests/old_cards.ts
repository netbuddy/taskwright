/**
 * 早先按阶段的固定卡片键（现在助手只发 next_step、goto:<活动标识符>、stay，见 src/lib/stage.ts）。任务库里还开着的旧卡片照样认：
 * 这里的测试用它们当「早先发的卡片」，核对换算表 LEGACY_CARD_MOVES 照旧生效。只是测试的夹具，产品代码不用。
 */

import type { CardOption, Stage } from "../src/lib/stage.ts";

export const OLD_STAY_TEXT = "继续本阶段";
export const START_ITEMS_KEY = "start_items";
export const START_ITEMS_TEXT = "开始写条目";
export const CONTINUE_CLARIFY_KEY = "continue_clarify";
export const CONTINUE_CLARIFY_TEXT = OLD_STAY_TEXT;

export const ENTER_OPTIONS: Record<Stage, CardOption> = {
  reading: { key: "enter_reading", text: "开始核读材料" },
  clarifying: { key: "enter_clarify", text: "进入澄清" },
  modeling: { key: "enter_consolidate", text: "进入整理建模" },
  writing: { key: START_ITEMS_KEY, text: START_ITEMS_TEXT },
  reviewing: { key: "enter_review", text: "进入评审确认" },
  document: { key: "enter_document", text: "进入编写文档" },
};

export const STAY_OPTIONS: Record<Exclude<Stage, "document">, CardOption> = {
  reading: { key: "continue_reading", text: OLD_STAY_TEXT },
  clarifying: { key: CONTINUE_CLARIFY_KEY, text: OLD_STAY_TEXT },
  modeling: { key: "continue_consolidate", text: OLD_STAY_TEXT },
  writing: { key: "continue_writing", text: OLD_STAY_TEXT },
  reviewing: { key: "continue_review", text: OLD_STAY_TEXT },
};

export const STAY_IDLE_OPTION: CardOption = { key: "stay_idle", text: "先不开始" };

export const BACK_OPTIONS: Record<Exclude<Stage, "document">, CardOption> = {
  reading: { key: "back_to_reading", text: "退回核读材料" },
  clarifying: { key: "back_to_clarify", text: "退回澄清" },
  modeling: { key: "back_to_consolidate", text: "退回整理建模" },
  writing: { key: "back_to_writing", text: "退回写条目" },
  reviewing: { key: "back_to_review", text: "退回评审确认" },
};

export const STAY_HERE_OPTION: CardOption = { key: "stay_in_stage", text: "留在本段" };
