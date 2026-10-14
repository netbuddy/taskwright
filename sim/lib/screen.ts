/**
 * 用户 agent 眼里的界面：把后端整份数据里的对话与条目区，写成一个坐在工作视图前的人看到的文字；
 * 以及把「回应」的参数翻成对后端的一次请求。纯函数，不依赖 pi，也不发请求，单元测试直接调用。
 *
 * 看到什么：执行者新说的话（回复的告知、主行为、成文正文，以及可以点的按钮）、
 * 条目区现状（各集合条目数、每个条目的编号与标题；给编号时看这个条目的字段）。不给完成条件、材料原文、条目改动过的修订。
 * 总体分析这个集合在条目区里写成提纲：每页一行，写标题、标签，以及这一页现在的样子用户看没看过、有没有助手补的内容等着确认。
 * 助手画的图另列一段：每张一行，写图名、种类、画自哪几页、现在这一版用户看没看过；给图的编号时看这张图的说明与 Mermaid 文本。
 */

export interface Act {
  kind: "ask" | "confirm" | "suggest" | "choose" | "propose";
  text: string;
  items?: { item_id: string; revision_no: number }[];
  options?: { key: string; text: string }[];
  value?: string;
  basis?: { kind: string; locator: string; excerpt: string }[];
  preview?: { effect: string; text: string }[];
  /** 只有提问、给建议值、提议可以写，取值只有 general：与任何条目都无关，这时没有 items。界面上只是不列涉及的条目。 */
  scope?: "general";
}

export interface Message {
  type: string;
  message_id: string | null;
  text?: string;
  /** 告知：后端交来的是 { text, items }；旧的记录里可能是一句纯文字。 */
  informs?: (string | { text: string; items?: { item_id: string }[] })[];
  act?: Act | null;
  via_reply_tool?: boolean;
  /** 连续被拒到上限后放行的纯文字回复：界面照普通文字显示，加一行说明，不画卡片（与前端工作视图一致）。 */
  degraded?: boolean;
}

/** 这条回复在界面上有没有卡片：degraded 的回复即使带着 act 也不画。 */
export function cardOf(m: Message | null | undefined): Act | null {
  return m && !m.degraded ? m.act ?? null : null;
}

/** 界面上「标为先不管」要写的那个枚举取值；前端按它认出问题条目一类的集合（web 的 keepPendingField）。 */
export const KEEP_PENDING_VALUE = "用户决定保留";
export const DONT_KNOW = "我不知道，你按常识补";

/** 这个集合有没有取值里带「用户决定保留」的枚举字段，也就是能不能「标为先不管」。 */
function keepable(task: TaskView | null | undefined, itemId: string): boolean {
  const item = task?.items.find((i) => i.item_id === itemId);
  const collection = item && task!.definition.collections.find((c) => c.name === item.collection);
  return !!collection?.fields.some((f) => f.type === "枚举" && (f.values ?? []).includes(KEEP_PENDING_VALUE));
}

/** 提问卡片上「先不管」按钮对应的条目：卡片挂着条目（不是 scope general）时，其中能标为先不管的那些。 */
function keepTargets(act: Act, task: TaskView | null | undefined): string[] {
  if (act.kind !== "ask" || act.scope === "general" || !act.items?.length) return [];
  return act.items.map((i) => i.item_id).filter((id) => keepable(task, id));
}

/** 「先不管」按钮的名字：只有一条时叫「先不管这条」，多条时每条一个「先不管 编号」（与前端一致）。 */
function keepButtons(act: Act, task: TaskView | null | undefined): Map<string, string> {
  const ids = keepTargets(act, task);
  return new Map(ids.map((id) => [ids.length === 1 ? "先不管这条" : `先不管 ${id}`, id]));
}

/**
 * 每种卡片可以点的按钮，与前端工作视图一致。choose 的按钮就是各选项的 key。
 * 提问挂在条目上（不是 scope general、items 不为空）时有两类按钮：能标为先不管的条目各一个「先不管」，
 * 再加一个「我不知道，你按常识补」；判断「能不能标为先不管」要看任务定义，所以要传条目区的数据。
 */
export function buttonsOf(act: Act | null | undefined, task?: TaskView | null): string[] {
  if (!act) return [];
  if (act.kind === "confirm") return [SEEN, "不对"];
  if (act.kind === "choose") return (act.options ?? []).map((o) => o.key);
  if (act.kind === "suggest") return ["采纳", "换一个"];
  if (act.kind === "propose") return ["就这样做", "不要"];
  if (act.kind === "ask" && act.scope !== "general" && act.items?.length) return [...keepButtons(act, task).keys(), DONT_KNOW];
  return [];
}

/**
 * 助手提议进入下一个阶段的卡片，与网页认的是同一种（web/src/components/work/ReplyCard.tsx）：请选择，其中一个选项的键是进入某个阶段的
 * （start_items，或者以 enter_ 开头）。这种卡片上留在这一段的那个选项（键以 continue_ 开头）页面一律写成「继续本阶段」，
 * 点它不替用户发话，只发一个界面操作 continue_stage：卡片标为已选，助手不因此运行，提议仍然开着。
 */
export const STAY_TEXT = "继续本阶段";
export const CONTINUE_STAGE = "continue_stage";
const isEnterKey = (key: string): boolean => key === "start_items" || key.startsWith("enter_");

export function isStageCard(act: Act | null | undefined): boolean {
  return act?.kind === "choose" && (act.options ?? []).some((o) => isEnterKey(o.key));
}

/**
 * 助手提议的另两种卡片，也与网页认的是同一种：提议退回前面的阶段（一个选项的键以 back_to_ 开头，另一项 stay_in_stage 页面写成「留在本段」），
 * 编写文档阶段请用户过目补写的页（document_reviewed「看过了，生成文档」与 document_revise「需要修改」）。
 * 「留在本段」「需要修改」与「继续本阶段」一样只发界面操作 continue_stage；「看过了，生成文档」也不发话：先发 continue_stage，
 * 再把卡片点名的页标为已读（mark_viewed，不通知助手），助手不因此运行。
 */
export const STAY_HERE_KEY = "stay_in_stage";
export const STAY_HERE_TEXT = "留在本段";
export const DOCUMENT_REVIEWED_KEY = "document_reviewed";
export const DOCUMENT_REVISE_KEY = "document_revise";
export const DOCUMENT_REVISE_TEXT = "需要修改";
const isBackKey = (key: string): boolean => key.startsWith("back_to_");

/** 一张卡片是助手的哪一种提议：进入下一个阶段、退回前面的阶段、请用户过目补写的页；不是提议是 null。照这个先后取第一种对得上的。 */
export function proposalKind(act: Act | null | undefined): "enter" | "back" | "review" | null {
  if (act?.kind !== "choose") return null;
  const keys = (act.options ?? []).map((o) => o.key);
  if (keys.some(isEnterKey)) return "enter";
  if (keys.some(isBackKey)) return "back";
  return keys.includes(DOCUMENT_REVIEWED_KEY) ? "review" : null;
}

/** 这个键是不是提议的卡片上不生效的那个选项：进入卡片上留在这一段的、回退卡片上的「留在本段」、请过目卡片上的「需要修改」。 */
export function isStayOption(act: Act | null | undefined, key: string): boolean {
  return proposalKind(act) !== null && (key.startsWith("continue_") || key === STAY_HERE_KEY || key === DOCUMENT_REVISE_KEY) && (act!.options ?? []).some((o) => o.key === key);
}

/** 这个键是不是请过目卡片上的「看过了，生成文档」。 */
export function isReviewedOption(act: Act | null | undefined, key: string): boolean {
  return proposalKind(act) === "review" && key === DOCUMENT_REVIEWED_KEY;
}

/** 请选择卡片上一个选项给人看的文字：提议的卡片上不生效的那一项照页面写固定的字（「继续本阶段」「留在本段」「需要修改」），别的照助手写的。 */
function optionLabel(act: Act, option: { key: string; text: string }): string {
  if (!isStayOption(act, option.key)) return option.text;
  return option.key === STAY_HERE_KEY ? STAY_HERE_TEXT : option.key === DOCUMENT_REVISE_KEY ? DOCUMENT_REVISE_TEXT : STAY_TEXT;
}

/**
 * 请选择卡片上点的是哪个选项：写选项的键或者选项的文字都认，返回选项的键；都对不上时原样返回。
 * 界面上人看到的是选项的文字（例如「开始写条目」），键是给程序认的（start_items），所以两种写法都收。
 * 文字先按界面上显示的认（留在这一段的那一项是「继续本阶段」），再按助手在卡片里写的认。
 */
export function optionKeyOf(act: Act | null | undefined, click: string): string {
  if (!act || act.kind !== "choose") return click;
  const options = act.options ?? [];
  return (options.find((o) => o.key === click) ?? options.find((o) => optionLabel(act, o) === click) ?? options.find((o) => o.text.trim() === click))?.key ?? click;
}

/** 卡片上的按钮给人看的名字：请选择卡片写选项的文字（进入卡片上留在这一段的那一项写「继续本阶段」），其余就是按钮名。 */
export function buttonLabels(act: Act | null | undefined, task?: TaskView | null): string[] {
  if (act?.kind === "choose") return (act.options ?? []).map((o) => optionLabel(act, o));
  return buttonsOf(act, task);
}

/** 「请确认」卡片上的按钮：点一次把卡片点名的条目标为已读（已读就算确认）。 */
export const SEEN = "这几条都看过了";

const KIND_WORD: Record<string, string> = { ask: "提问", confirm: "请确认", suggest: "建议", choose: "请选择", propose: "提议" };
const EFFECT_WORD: Record<string, string> = { remove: "去掉", add: "加上", change: "改动" };

/** 一条执行者的回复写成用户看到的样子。 */
export function renderReply(m: Message, task?: TaskView | null): string {
  const lines: string[] = [];
  if (m.degraded) return [`（界面注明：这条回复没有按结构发出。）`, `助手说：${m.text ?? ""}`].join("\n");
  const act = cardOf(m);
  // 与网页一致：有卡片时告知逐条列出，点名的条目跟在后面；没有卡片时只有正文，正文下方一行「提到的条目」。
  const informs = (m.informs ?? []).map((one) => (typeof one === "string" ? { text: one, items: [] } : { text: one.text, items: one.items ?? [] }));
  const ids = (list: typeof informs) => [...new Set(list.flatMap((one) => one.items.map((i) => i.item_id)))];
  if (act) for (const one of informs) lines.push(`助手告诉你：${one.text}` + (one.items.length ? `（${ids([one]).join("、")}）` : ""));
  lines.push(`助手说：${m.text ?? ""}`);
  if (!act && ids(informs).length) lines.push(`提到的条目：${ids(informs).join("、")}`);
  if (act) {
    lines.push(`【卡片：${KIND_WORD[act.kind] ?? act.kind}】${act.text}`);
    if (act.items?.length) lines.push(`涉及的条目：${act.items.map((i) => `${i.item_id}（修订 ${i.revision_no}）`).join("、")}`);
    if (act.kind === "choose") for (const o of act.options ?? []) lines.push(`选项 ${o.key}：${optionLabel(act, o)}`);
    if (act.kind === "suggest") {
      lines.push(`建议的值：${act.value ?? ""}`);
      for (const b of act.basis ?? []) lines.push(`依据（${b.kind}）：${b.excerpt}`);
    }
    if (act.kind === "propose") for (const p of act.preview ?? []) lines.push(`这样做会${EFFECT_WORD[p.effect] ?? p.effect}：${p.text}`);
    const buttons = buttonLabels(act, task);
    const how = act.kind === "choose" ? "写选项的文字或者它前面的键都行；也可以直接回一句话" : "也可以直接回一句话";
    lines.push(buttons.length ? `可以点：${buttons.join("／")}（${how}）` : "这张卡片没有按钮，直接回一句话。");
  }
  return lines.join("\n");
}

/** 对话里的新消息（上一次看界面之后出现的）写成文字；自己说的话不再复述。 */
export function renderMessages(messages: Message[], task?: TaskView | null): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.type === "assistant_reply") parts.push(renderReply(m, task));
    else if (m.type === "system_note") parts.push(`系统说明：${m.text ?? ""}`);
    else if (m.type === "ui_action_noted") parts.push(`界面记下了你刚才的操作：${m.text ?? ""}`);
  }
  return parts.length ? parts.join("\n\n") : "（助手这次没有说新的话。）";
}

export interface Item {
  item_id: string;
  collection: string;
  title: string;
  /** 条目当前所在的修订号。 */
  revision_no: number;
  fields: Record<string, unknown>;
  /** 确认标记，按记下的先后；basis 是依据：viewed（已读）、ui_click、ui_edit（用户亲手改）、user_words。 */
  confirmations?: { revision_no: number; accepted: boolean; basis?: string }[];
  /** 条目在任何一次修订上有过接受的确认标记；没有就是未读。 */
  viewed?: boolean;
  /** 待核实：当前修订上有助手补充的内容，而用户还没有确认过。 */
  pending_verification?: boolean;
  /** 还待核实的助手补充来源有几条。 */
  pending_sources?: number;
  /** 还待核实的各处：字段与（列表字段的）第几项，从 0 起；field 为 null 指整个条目。 */
  pending_places?: { field: string | null; index: number | null }[];
  /** 被谁依据：把这个条目写成来源的别的条目与图（element_kind 是「条目」或「图」）。 */
  depended_by?: { element_kind: string; id: string }[];
}

/** 总体分析这个集合的名字与它的几个字段名，与 agent/src/lib/overall_analysis.ts 一致。 */
export const OVERALL = "总体分析";
const TAGS_FIELD = "标签";
const STATUS_FIELD = "状态";
const DEPRECATED = "已废弃";

/** 一页待不待核实、有几处：与网页的 pendingCount（web/src/model/overall.ts）同一个算法。 */
export function pendingCount(item: Item): number {
  return item.pending_verification ? Math.max(1, item.pending_sources ?? 1) : 0;
}

/**
 * 一页现在这一版用户看没看过：它当前所在的修订上，依据不是用户亲手改的确认标记里，最近一条是接受。
 * 用户 agent 不会亲手改字段，所以这与产品里「用户看过」的判法（从最近一次助手保存起的那一段修订）结果相同。
 */
export function viewedNow(item: Item): boolean {
  const marks = (item.confirmations ?? []).filter((c) => c.revision_no === item.revision_no && c.basis !== "ui_edit");
  return marks.length > 0 && marks[marks.length - 1].accepted;
}

/**
 * 用户打开一个条目时要不要记为已读（返回要记的目标，不记时为 null），与网页同一个规矩（web/src/model/overall.ts 的 viewOnOpen）：
 * 别的条目打开就记；总体分析里待核实的页打开时不记——记了它就不再待核实，而助手补的那几处用户也许还没有看。
 * confirm 为真相当于在那一页上点了「确认待核实的 N 处」（网页的 confirmAction）：在它现在所在的修订上记一条已读。
 */
export function viewOnLook(task: TaskView | null | undefined, itemId: string, confirm = false): { item_id: string; base_revision: number } | null {
  const item = task?.items.find((i) => i.item_id === itemId);
  if (!item) return null;
  if (item.collection === OVERALL && pendingCount(item) > 0 && !confirm) return null;
  return { item_id: item.item_id, base_revision: item.revision_no };
}

/** 还待核实的各处写成一句：「例子」第 1 项、「它是什么」；指整个条目的写「整页」。 */
function placesText(item: Item): string {
  const places = item.pending_places ?? [];
  if (!places.length) return "";
  return places.map((at) => (at.field === null ? "整页" : `「${at.field}」${at.index !== null ? `第 ${at.index + 1} 项` : ""}`)).join("、");
}

/** 提纲里一页的那一行：编号、标题、标签，以及四种状态之一。 */
function outlineLine(item: Item): string {
  const tags = Array.isArray(item.fields[TAGS_FIELD]) ? (item.fields[TAGS_FIELD] as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "") : [];
  const head = `${item.item_id}「${item.title}」${tags.length ? `〔${tags.join("、")}〕` : ""}`;
  if (item.fields[STATUS_FIELD] === DEPRECATED) return `${head}：已废弃`;
  const pending = pendingCount(item);
  if (pending) return `${head}：有 ${pending} 处是助手补的，等你确认`;
  return `${head}：${viewedNow(item) ? "你看过现在这一版了" : "你还没看过现在这一版"}`;
}

export interface TaskView {
  definition: { collections: { name: string; fields: { name: string; type?: string; values?: string[] | null }[] }[] };
  items: Item[];
  /** 任务里还在的图。旧后端没有这一项。 */
  diagrams?: Diagram[];
  /** 任务现在的工作阶段；这里只用其中「开展一项活动」一节。没有阶段的任务、旧后端没有这一项。 */
  stage?: { current?: string; launch?: LaunchView | null } | null;
}

/** 任务状况卡上「开展一项活动」一节里可以点的一项（后端算好，agent/src/lib/stage.ts 的 LaunchOption）。 */
export interface LaunchOption {
  activity: string;
  in_flow: boolean;
  label: string;
  enabled: boolean;
  state: string;
}

/** 「开展一项活动」一节：正在进行的活动（只是一行）、可以启动或继续的流程、可以单独开展的活动、以后才有的。 */
export interface LaunchView {
  current: { activity: string; in_flow: boolean; label: string } | null;
  flows: LaunchOption[];
  activities: LaunchOption[];
  later: { label: string; state: string }[];
}

/** 点了「开展一项活动」里的一项发的界面操作（与网页一致）：只记活动记录、在对话里留一行，不替用户发话，助手不因此运行。 */
export const START_ACTIVITY = "start_activity";
/** 这一节不选任何一项时的写法：什么都不发。 */
export const LAUNCH_SKIP = "不选";
/** 单独开展一项活动时的写法的前缀：「单独开展：澄清」。 */
export const LAUNCH_ALONE_PREFIX = "单独开展：";

/** 「看界面」里「开展一项活动」一节怎样写；任务没有这一节时是空字符串。 */
export function renderLaunch(launch: LaunchView | null | undefined): string {
  if (!launch) return "";
  const one = (option: LaunchOption, name: string) => `${name}${option.enabled ? "" : `（现在不能选：${option.state}）`}`;
  return [
    "任务状况卡上的「开展一项活动」（不是必须选；想选就在 respond 的 launch 里照下面的写法写一项，不选可以直接说话）：",
    ...(launch.current ? [`  正在进行：${launch.current.label}`] : ["  现在没有在进行的活动，任务空闲。"]),
    `  流程：${launch.flows.map((option) => one(option, option.label)).join("、")}`,
    `  单独开展：${launch.activities.map((option) => one(option, `${LAUNCH_ALONE_PREFIX}${option.label}`)).join("、")}`,
  ].join("\n");
}

/**
 * 按写法在这一节里找一项。流程的一项写按钮上的字，「启动需求分析」「继续需求分析」写到这里就认（后面「（从某阶段接着）」可以不写）；
 * 单独开展的写「单独开展：活动名」。写的是「不选」时返回 null。找不到、或者那一项现在不能选时抛错，写明可以选的有哪些。
 */
export function launchOption(launch: LaunchView | null | undefined, wanted: string): LaunchOption | null {
  const name = wanted.trim();
  if (name === LAUNCH_SKIP) return null;
  if (!launch) throw new Error("任务状况卡上现在没有「开展一项活动」这一节（任务已经结束，或者这个任务没有阶段）");
  const found = name.startsWith(LAUNCH_ALONE_PREFIX)
    ? launch.activities.find((option) => option.label === name.slice(LAUNCH_ALONE_PREFIX.length).trim())
    : launch.flows.find((option) => option.label === name || option.label.startsWith(`${name}（`));
  const offered = [...launch.flows.map((option) => option.label), ...launch.activities.map((option) => `${LAUNCH_ALONE_PREFIX}${option.label}`), LAUNCH_SKIP];
  if (!found) throw new Error(`「开展一项活动」里没有「${name}」这一项，可以写的是：${offered.join("／")}`);
  if (!found.enabled) throw new Error(`「${name}」现在不能选：${found.state}`);
  return found;
}

/** 选一项要发的请求：界面操作 start_activity；「不选」什么都不发。 */
export function planLaunch(launch: LaunchView | null | undefined, wanted: string, clientId: string): Plan {
  const option = launchOption(launch, wanted);
  if (option === null) return { kind: "none" };
  return { kind: "action", body: { client_id: clientId, kind: START_ACTIVITY, targets: [], notify_executor: false, fields: { activity: option.activity, in_flow: option.in_flow } } };
}

function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.map((v, i) => `${i + 1}. ${v}`).join("；") : "（空）";
  if (value === undefined || value === null || value === "") return "（空）";
  return String(value);
}

/**
 * 条目区：各集合几个条目、每个条目的编号与标题；给了编号就只看这一个条目的字段。
 * confirm 只对总体分析里待核实的页有意义：为真是确认这一页上助手补的几处，为假时只是看，并写明还有哪几处等着确认。
 */
export function renderItems(task: TaskView | null, itemId?: string, confirm = false): string {
  if (!task) return "条目区：还没有任务。";
  if (itemId) {
    const item = task.items.find((i) => i.item_id === itemId);
    if (!item) return `条目区里没有 ${itemId}。`;
    const declared = task.definition.collections.find((c) => c.name === item.collection)?.fields.map((f) => f.name) ?? Object.keys(item.fields);
    const pending = item.collection === OVERALL ? pendingCount(item) : 0;
    // 打开一个条目看它现在的内容就算看过（已读），「看界面」带条目编号时工具会替你记下；待核实的主题页要另外确认。
    const mark = !pending ? "（你正在看它现在的内容，看过就算确认）"
      : confirm ? `（你正在看它现在的内容，并确认了助手补的 ${pending} 处）` : "（你正在看它现在的内容）";
    const lines = [`${item.item_id}「${item.title}」，集合「${item.collection}」，修订 ${item.revision_no}${mark}：`,
      ...declared.map((name) => `  ${name}：${valueText(item.fields[name])}`)];
    if (pending && !confirm) {
      const where = placesText(item);
      lines.push(`这一页有 ${pending} 处是助手补的，还没有确认${where ? `：${where}` : ""}。你看了觉得对，就再看一次这一页并把 confirm 设为 true；觉得不对，直接说哪里不对。`);
    }
    return lines.join("\n");
  }
  const lines = ["条目区："];
  for (const c of task.definition.collections) {
    const items = task.items.filter((i) => i.collection === c.name);
    if (c.name === OVERALL) {
      // 总体分析写成提纲：一页一行，让人知道有哪些页可以看、哪一页还等着确认。
      lines.push(`  ${c.name} ${items.length} 页${items.length ? "：" : ""}`);
      for (const item of items) lines.push(`    ${outlineLine(item)}`);
      continue;
    }
    lines.push(`  ${c.name} ${items.length} 个${items.length ? "：" + items.map((i) => `${i.item_id}「${i.title}」${i.viewed === false ? "（未读）" : ""}`).join("、") : ""}`);
  }
  return lines.join("\n");
}

/** 图的列表里的一项（整份数据的 task.diagrams）；详情接口另给 mermaid、note、sources。 */
export interface Diagram {
  diagram_id: string;
  name: string;
  kind: string;
  kind_name: string;
  /** 这张图自己的修订号，从 1 起。 */
  revision_no: number;
  /** 用户看没看过它现在这一版。 */
  viewed?: boolean;
  mermaid?: string;
  note?: string | null;
  sources?: { kind: string; locator: string }[];
}

/** 来源与「被谁依据」里图这一种的写法，与 agent/src/lib/schema.ts 的 SOURCE_FIGURE 一致；条目这一种写「条目」。 */
const FIGURE = "图";
const ITEM_SOURCE = "条目";

/** 一张图画自哪几页：把它写成来源的总体分析的页（每一页的 depended_by），照条目区里的先后。与网页把图放进节里用的是同一份数据。 */
export function sourcePagesOf(task: TaskView | null | undefined, diagramId: string): string[] {
  return (task?.items ?? []).filter((item) => item.collection === OVERALL && (item.depended_by ?? []).some((one) => one.element_kind === FIGURE && one.id === diagramId))
    .map((item) => item.item_id);
}

/** 助手画的图那一段：每张一行，写编号、图名、种类、画自哪几页、现在这一版看没看过。一张图都没有时是空字符串。 */
export function renderDiagrams(task: TaskView | null | undefined): string {
  const diagrams = task?.diagrams ?? [];
  if (!diagrams.length) return "";
  const lines = [`助手画的图 ${diagrams.length} 张（想看哪一张，look 时在 diagram_id 里写它的编号）：`];
  for (const one of diagrams) {
    const pages = sourcePagesOf(task, one.diagram_id);
    lines.push(`  ${one.diagram_id}「${one.name}」（${one.kind_name}）：${pages.length ? `画自 ${pages.join("、")}` : "没有写画自哪一页"}；${one.viewed ? "你看过现在这一版了" : "你还没看过现在这一版"}`);
  }
  return lines.join("\n");
}

/** 打开一张图看到的文字：图名、种类、说明、画自哪几页、Mermaid 文本。detail 是详情接口交来的那张图，没有这张图时传 null。 */
export function renderDiagram(detail: Diagram | null | undefined, diagramId: string): string {
  if (!detail) return `助手画的图里没有 ${diagramId}。`;
  const pages = (detail.sources ?? []).filter((one) => one.kind === ITEM_SOURCE).map((one) => one.locator);
  return [`${detail.diagram_id}「${detail.name}」，${detail.kind_name}，修订 ${detail.revision_no}（你正在看它现在这一版，看过就记为看过）：`,
    `  说明：${valueText(detail.note)}`,
    `  画自：${pages.length ? pages.join("、") : "（没有写）"}`,
    "  图的文本（Mermaid 写法）：",
    ...(detail.mermaid ?? "").split("\n").map((line) => `    ${line}`)].join("\n");
}

/** 用户打开一张图时要记的目标（界面操作 mark_diagram_viewed 的 targets 里的一项）：图的编号与用户看到的那一次修订号；没有这张图时为 null。 */
export function viewOnLookDiagram(detail: Diagram | null | undefined): { diagram_id: string; base_revision: number } | null {
  return detail ? { diagram_id: detail.diagram_id, base_revision: detail.revision_no } : null;
}

/** 「回应」的参数。 */
export interface RespondParams {
  text?: string;
  click?: string;
  /** 在任务状况卡的「开展一项活动」里选一项，照「看界面」列出的写法写；写「不选」是不选。不与 text、click 同时写。 */
  launch?: string;
  done?: boolean;
  give_up?: boolean;
  reason?: string;
}

/** 一次回应要发给后端的请求：说话、直接操作（then 是紧接着发的第二个直接操作），或者什么都不发（只表示结束或放弃）。 */
export type Plan =
  | { kind: "message"; body: Record<string, unknown> }
  | { kind: "action"; body: Record<string, unknown>; then?: Record<string, unknown> }
  | { kind: "none" };

const CLICK_TEXT: Record<string, string> = { 不对: "这个不对。", 采纳: "我采纳这个建议。", 换一个: "请换一个建议。", 就这样做: "就这样做。", 不要: "不要这样做。" };

/**
 * 按接口约定（docs/api.md「卡片上的按钮」）把一次回应翻成请求：「这几条都看过了」走 actions 的 mark_viewed（带 notify_executor），其余按钮走 messages 带 card，
 * 话用第 7 节的模板；说话走 messages。提议的卡片上不生效的那一项（「继续本阶段」「留在本段」「需要修改」）走 actions 的 continue_stage，不发话，助手不因此运行；
 * 请过目卡片上的「看过了，生成文档」先发 continue_stage、再发 mark_viewed（不通知助手），同样不发话。
 * 在「开展一项活动」里选一项（launch）走 actions 的 start_activity，不发话，助手不因此运行；写「不选」什么都不发。形式不对时抛异常，写明哪里不对。
 */
export function planRespond(params: RespondParams, lastReply: Message | null, clientId: string, task?: TaskView | null): Plan {
  const p = params ?? {};
  const text = typeof p.text === "string" ? p.text.trim() : "";
  const act = cardOf(lastReply);
  const clicked = typeof p.click === "string" ? p.click.trim() : "";
  const click = clicked ? optionKeyOf(act, clicked) : "";
  const errors: string[] = [];
  const launch = typeof p.launch === "string" ? p.launch.trim() : "";
  if (launch) {
    if (text || click) throw new Error("这次回应的形式不对，没有发出去：选「开展一项活动」里的一项时不要同时写 text 或 click；要说话就另外回一次。");
    try {
      return planLaunch(task?.stage?.launch, launch, clientId);
    } catch (error) {
      throw new Error(`这次回应的形式不对，没有发出去：${(error as Error).message}。`);
    }
  }
  if (p.done && p.give_up) errors.push("done 与 give_up 不能同时为真");
  if (p.give_up && (typeof p.reason !== "string" || !p.reason.trim())) errors.push("give_up 要配一句 reason，说明为什么放弃");
  if (!text && !click && !p.done && !p.give_up) errors.push("要么写 text 说一句话，要么写 click 点一个按钮，要么用 done 或 give_up 结束");
  if (click) {
    const buttons = buttonsOf(act, task);
    if (!buttons.length) errors.push("助手最近一条话没有可以点的按钮，请用 text 直接说");
    else if (!buttons.includes(click)) errors.push(`没有「${clicked}」这个按钮，可以点的是：${buttonLabels(act, task).join("／")}`);
    if (text && click !== "不对") errors.push("点这个按钮时不要同时写 text；要说话就另外回一次");
  }
  if (errors.length) throw new Error(`这次回应的形式不对，没有发出去：${errors.join("；")}。`);
  if (click && act) {
    if (click === SEEN) {
      return { kind: "action", body: { client_id: clientId, kind: "mark_viewed", notify_executor: true,
        targets: (act.items ?? []).map((i) => ({ item_id: i.item_id, base_revision: i.revision_no })) } };
    }
    const keep = keepButtons(act, task).get(click);
    if (keep) {
      // 与前端一致：直接操作 keep_pending，带通知；修订号取卡片上写的，没写就取条目区里它当前所在的修订。
      const base = act.items?.find((i) => i.item_id === keep)?.revision_no ?? task?.items.find((i) => i.item_id === keep)?.revision_no;
      return { kind: "action", body: { client_id: clientId, kind: "keep_pending", notify_executor: true, targets: [{ item_id: keep, base_revision: base }] } };
    }
    if (click === DONT_KNOW) {
      const ids = (act.items ?? []).map((i) => i.item_id).join("、");
      return { kind: "message", body: { text: `关于 ${ids}，我不知道，你按常识补上并标明是你补的。`, client_id: clientId, origin: "card_choice",
        card: { reply_message_id: lastReply?.message_id ?? null, kind: act.kind, choice: "不知道" } } };
    }
    if (isStayOption(act, click)) {
      // 与网页一致：只留一条界面操作通知，提议仍然开着；fields 写卡片所在回复的编号与点的键。
      return { kind: "action", body: { client_id: clientId, kind: CONTINUE_STAGE, targets: [], notify_executor: false,
        fields: { reply_message_id: lastReply?.message_id ?? null, option_key: click } } };
    }
    if (isReviewedOption(act, click)) {
      // 与网页一致：先留通知（这时提议还开着），再把卡片点名的页标为已读；两步都不引出助手的一次运行。
      return { kind: "action", body: { client_id: clientId, kind: CONTINUE_STAGE, targets: [], notify_executor: false,
        fields: { reply_message_id: lastReply?.message_id ?? null, option_key: click } },
        ...((act.items ?? []).length ? { then: { client_id: `${clientId}-viewed`, kind: "mark_viewed", notify_executor: false,
          targets: (act.items ?? []).map((i) => ({ item_id: i.item_id, base_revision: i.revision_no })) } } : {}) };
    }
    const option = act.kind === "choose" ? act.options?.find((o) => o.key === click) : undefined;
    const said = option ? `我选：${option.text}` : click === "不对" && text ? text : CLICK_TEXT[click];
    return { kind: "message", body: { text: said, client_id: clientId, origin: "card_choice",
      card: { reply_message_id: lastReply?.message_id ?? null, kind: act.kind, choice: click } } };
  }
  if (text) return { kind: "message", body: { text, client_id: clientId } };
  return { kind: "none" };
}
