/**
 * 有阶段的任务用的说明文件（agent/prompts/stages/）的内容检查。只读这些文件，不改。
 *
 * 平台说明现在有两份：早先的任务经 --skill 读的那一份（agent/prompts/skills/taskwright-executor/SKILL.md），
 * 与有阶段的任务放进系统提示的共用部分（agent/prompts/stages/common.md）。两份的第一到九节与第十一节本应相同
 * （第十节两份各写各的，第十二节「随时可用的七项能力」只有共用部分有），
 * 这里逐段核对：把早先那一份套上下面 EDITS 表里列的几处有意的改动之后，要与共用部分一字不差。
 * 改了其中一份而没有改另一份，这例测试会指出第一处不同的段落；确是只该改一份的，在 EDITS 里加一条并写明原因。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderDocument } from "../../scripts/render-intent-schema.mjs";
import { EXCEPTION_EXAMPLE_PREFIX } from "../src/lib/overall_analysis.ts";
import { closedQuestion } from "../src/lib/reply.ts";
import { CHAPTERS } from "../src/lib/overall_chapters.ts";
import { RULE_CONFLICT_PREFIX } from "../src/lib/overall_views.ts";
import { PROBLEM_BLOCKING, PROBLEM_BLOCKING_FIELD, PROBLEM_LANDED_FIELD, PROBLEM_NOT_BLOCKING, PROBLEM_REVISIT_FIELD } from "../src/lib/definition.ts";
import { BACK_OPTIONS, ENTER_OPTIONS, type LampInput, PENDING_MARK, STAGES, STAGE_NAMES, STAY_HERE_OPTION, STAY_OPTIONS, type Stage, type WriteKind, canWrite, nextStage, stageLamps } from "../src/lib/stage.ts";
import { NO_PROPOSAL_LINE, openCardsLine } from "../src/lib/stage_proposal.ts";
import { CARD_TYPED_PREFIX } from "../src/lib/dialogue_acts.ts";

/** 一个什么都没有的任务的算灯事实：只用来数每个阶段有几盏灯。 */
const EMPTY_LAMP_INPUT: LampInput = {
  pages: [], items: [], questions: [], collections: [], materials: [], citedDocuments: [], diagrams: [], ruleConflicts: [],
  review: { failing: [], any: false }, completion: { satisfied: false, unmet: [] },
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEGACY = join(ROOT, "agent", "prompts", "skills", "taskwright-executor", "SKILL.md");
const STAGES_DIR = join(ROOT, "agent", "prompts", "stages");
const read = (name: string) => readFileSync(join(STAGES_DIR, name), "utf-8");

/** 两份里不比的两节：早先那一份的第十节写全部阶段的做法与早先的任务，共用部分的第十节只写各阶段都要用的；第十二节只有共用部分有。 */
const SECTION_TEN = "十、";
const SECTION_TWELVE = "十二、";

/**
 * 有意的改动：早先那一份里的 from（必须正好出现一次），在共用部分里是 to。to 为空串是整段删去。
 */
const EDITS: { why: string; from: string; to: string }[] = [
  {
    why: "第五节第 8 条：有阶段的任务里澄清是一问一答，每答一条就发一张「是否已解决」的卡片会打断节奏；改成答完的几条用一张卡片一起问，并写明了结时记落实到。早先的任务没有这个字段，也不分阶段，照旧。",
    from: "   - 不缺了，就在同一轮回复的末尾用请选择问用户这个问题是否已解决，在 `items` 里点名这个问题条目，选项固定三个：「已解决」「还没解决，继续改」「先不管，保留」。不要用请过目问，见第 5 条。\n   - 用户选「已解决」，就把问题的状态改为已解决，在处理结果里写明采纳的内容；选「先不管，保留」，就把状态改为「用户决定保留」，在处理结果里写明用户决定先保留。这两种都只改状态与处理结果两个字段。选「还没解决，继续改」，就问用户还要怎么改。",
    to: "   - 不缺了，这个问题在内容上就答完了；它的状态要用户在卡片上点过才能改。手上没有别的事要问时，在同一轮回复的末尾用请选择问这个问题是否已解决，在 `items` 里点名这个问题条目，选项固定三个：「已解决」「还没解决，继续改」「先不管，保留」。不要用请过目问，见第 5 条。\n   - 手上还有别的事要接着问时（澄清阶段一问一答就是这样），不要每答一条就发这张卡片：直接问下一件，开头用一句话带过刚记下的事，例如「借期 30 天，记进『借书』那一页了。」等到没有要问的了、或者要提议进入下一段之前，用一张这样的卡片把已经答完的几条一起问，`items` 点名这几条问题条目。只放答案已经写进条目的问题。\n   - 用户选「已解决」，就把卡片点名的问题的状态改为已解决（点名了几条就在一次保存里都改），在处理结果里写明采纳的内容，在「落实到」里写答案写进了哪里；选「先不管，保留」，就把状态改为「用户决定保留」，在处理结果里写明用户决定先保留。这两种都只改状态、处理结果与落实到。选「还没解决，继续改」，就问用户还要怎么改。",
  },
  {
    why: "读材料那一步：早先的任务读到的内容都整理成条目；有阶段的任务按阶段写，核读材料阶段写不了条目。",
    from: "把这次读到的几块里的内容整理成条目并保存（照任务 skill 的分批规矩），再读后面的块",
    to: "把这次读到的几块里的内容按现在这个阶段该写的东西整理并保存（核读材料阶段写主题页与问题条目，写条目阶段写条目；一次保存写多少照任务 skill 的分批规矩），再读后面的块",
  },
  {
    why: "第三节第 6 条：「把材料里的内容都写成条目之后再回复」对早先的任务是对的，有阶段的任务只做这个阶段能做的。",
    from: "6. **把用户交代的事做完再回复。** 用户要你整理材料，就把材料里的内容都写成条目之后再回复；不要只写了一部分就停下来。一次保存写不下时分几批保存，中间不回复用户。",
    to: "6. **把这个阶段该做的事做完再回复。** 用户交代的事，在现在这个阶段能做的那一部分做完之后再回复，不要只做了一部分就停下来；一次保存写不下时分几批保存，中间不回复用户。这个阶段不能做的那一部分，照「现在这个阶段」里「用户的话落在这一段之外时」说的办。",
  },
  {
    why: "第三节第 7 条与第五节第 8 条、系统提示重复，共用部分删去。",
    from: "\n7. **一次只问一件事。** 拿不准用户的意思时先问清楚再做，先问最影响其他条目的那一件。",
    to: "",
  },
  {
    why: "第五节开头先说清三种回应各用在什么时候，并举一个把二选一写成提问的反例。",
    from: "这时用回复工具把话重新说一遍。\n",
    to: "这时用回复工具把话重新说一遍。\n\n**先分清你要的是哪一种回应。** 要用户答是或否、或者在几个答案里挑一个，用请选择（`choose`），把可选的答案写成选项；要用户同意你打算怎样做，用提议（`propose`）；只有用户要自己说出内容、没法从几个选项里挑的开放问题，才用提问（`ask`）。反例：你拿不准用户是要「只立主题页然后停下」还是要「连条目一起整理」，这是在两种做法里挑一种，应当用请选择，把两种做法写成两个选项；写成提问「你希望只建总体分析页，还是同时整理完整的交付物？」是错的：提问的卡片上没有可点的选项，用户只能打字。提问里出现「是否」「能不能」「要不要」这类词时，工具会拒绝并要你改用请选择或提议。\n",
  },
  {
    why: "第五节第 7 条的例句本身是一道是非题，共用部分换成一个开放问题。",
    from: "例如：「材料里写了逾期要罚款，但没说逾期期间能不能续借，这会影响续借的办理前提。逾期未还的读者能不能续借？」",
    to: "例如：「材料里写了逾期要罚款，但没写每天罚多少，这会影响逾期还书的办理步骤。逾期每册每天罚多少钱？」",
  },
  {
    why: "第四节末尾：有阶段的任务里一处定不了时写「待定」并记问题条目（第十节第 9 条）。早先的任务没有这一条。",
    from: "\n\n## 五、怎样回复\n",
    to: "\n\n**还定不了的地方。** 一个字段现在定不了时写「待定：」加一句说明，不要空着，也不要自己编一个；同时记一条问题条目把这件事记下来，规矩见第十节第 9 条。\n\n## 五、怎样回复\n",
  },
  {
    why: "第十一节第 4 条：图上还没有定的节点以「待定：」开头。早先的任务没有这一条。",
    from: "界面据此列出图里画了哪些条目。只写任务里现有的条目编号。",
    to: "界面据此列出图里画了哪些条目。只写任务里现有的条目编号。一个节点画的事还没有定时，节点的文字以「待定：」开头，例如 `c{\"待定：借满时怎么办\"}`，并照第十节第 9 条记一条问题条目。",
  },
  {
    why: "画图：有阶段的任务要到整理建模阶段才能画，并且可以先提议。",
    from: "1. **只在用户要求时画。** 用户说「把这几个用例画成用例图」「给退款流程画一张时序图」这类话时才画；整理条目时不要主动画图。",
    to: "1. **什么时候画。** 核读材料与澄清两个阶段不能画图，工具会拒绝。从整理建模阶段起，用户说「把这几个用例画成用例图」「给退款流程画一张时序图」这类话时画；你觉得一张图能帮用户看清时先提议，用户同意之后再画，不要不问就画。整理建模阶段例外：这一段你主动把五种图画出来，不等用户提出，也不用先提议，见「现在这个阶段」。",
  },
];

/** 去掉开头两行 --- 之间的 frontmatter。 */
function body(text: string): string {
  const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(text);
  return match ? match[1] : text;
}

/** 按二级标题拆成节：键是标题那一行（不带「## 」），值是这一节的全文；第一个二级标题之前的不要。 */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = ("\n" + text).split("\n## ");
  for (const part of parts.slice(1)) out.set(part.slice(0, part.indexOf("\n")), "## " + part.replace(/\n+$/, "") + "\n");
  return out;
}

/** 早先那一份套上有意的改动。每一处改动必须正好对上一次，否则说明那句话已经变了，表要跟着改。 */
function edited(text: string): string {
  let out = text;
  for (const edit of EDITS) {
    const found = out.split(edit.from).length - 1;
    assert.equal(found, 1, `EDITS 里这一条在早先那一份平台说明里应当正好出现一次，现在是 ${found} 次（${edit.why}）`);
    out = out.replace(edit.from, edit.to);
  }
  return out;
}

test("共用部分的第一到九节与第十一节，同早先那一份平台说明逐段相同；有意不同的几处都列在表上", () => {
  const legacy = sections(edited(body(readFileSync(LEGACY, "utf-8"))));
  const common = sections(read("common.md"));
  const titles = (all: Map<string, string>) => [...all.keys()].filter((title) => !title.startsWith(SECTION_TEN) && !title.startsWith(SECTION_TWELVE));
  assert.deepEqual(titles(common), titles(legacy), "两份的节标题与次序应当相同（第十、十二节除外）");
  assert.equal(titles(common).length, 10);
  for (const title of titles(common)) {
    const want = legacy.get(title)!.split("\n");
    const got = common.get(title)!.split("\n");
    for (let i = 0; i < Math.max(want.length, got.length); i++) {
      assert.equal(got[i], want[i], `「${title}」一节第 ${i + 1} 行两份不同。两份都该改就都改；只该改一份的，在本文件的 EDITS 里加一条并写明原因`);
    }
  }
});

test("共用部分不带 frontmatter，不提早先的任务，理解格式那一段由同一个脚本生成", () => {
  const text = read("common.md");
  assert.ok(text.startsWith("# 在 Taskwright 里怎样工作\n"));
  assert.doesNotMatch(text, /领域说明|老任务|早先建的任务/);
  assert.doesNotMatch(text, /<!--/);
  assert.equal(renderDocument(text), text, "common.md 的理解格式生成区过期了，跑 node scripts/render-intent-schema.mjs");
});

test("共用部分的第十节只写各阶段都要用的：六个阶段、阶段不由助手移动、往前的五张卡片与回退卡片的写法、开着的提议、复述卡片、主题页的四件事、局部不明白时怎么办", () => {
  const ten = [...sections(read("common.md"))].find(([title]) => title.startsWith(SECTION_TEN))![1];
  for (const name of STAGES.map((one) => STAGE_NAMES[one])) assert.ok(ten.includes(name), name);
  assert.ok(ten.includes("1. **工作分六个阶段。**"));
  // 阶段不由助手移动：stage 与 reason 已经停用；退回只在输入大面积不能用时提议，五个退回的键与「留在本段」同程序里的常量。
  assert.ok(ten.includes("2. **阶段不由你移动。**"));
  assert.ok(ten.includes("回复里的 `stage` 与 `reason` 已经停用，写了回复会被拒绝。"));
  assert.ok(ten.includes("这一段要用的东西大面积不能用了，例如用户放进了新材料，或者几页主题的理解互相矛盾"));
  for (const one of Object.values(BACK_OPTIONS)) assert.ok(ten.includes(`\`${one.key}\`「${one.text}」`), one.key);
  assert.ok(ten.includes(`\`${STAY_HERE_OPTION.key}\`「${STAY_HERE_OPTION.text}」`));
  assert.ok(!ten.includes("你自己只能退回"));
  // 往前的五张卡片：进入下一段与留在这一段两个选项，键与文字同程序里的常量。
  for (const from of STAGES.filter((one) => one !== "document")) {
    const enter = ENTER_OPTIONS[nextStage(from) as Exclude<Stage, "reading">], stay = STAY_OPTIONS[from as Exclude<Stage, "document">];
    assert.ok(ten.includes(`\`${enter.key}\`「${enter.text}」、\`${stay.key}\`「${stay.text}」`), from);
  }
  // 开着的提议：从哪里知道、开着时怎么办。
  assert.ok(ten.includes("写着「开着的提议」时，用户说要进入、要退回或者说看过了，请他点输入框上方「待决定」一行里的按钮，不要重发同一张卡片"));
  assert.ok(ten.includes(NO_PROPOSAL_LINE.replace("。", "")));
  for (const word of ["`story_ok`", "`story_fix`", "`story_again`"]) assert.ok(ten.includes(word), word);
  for (const word of ["**待核实。**", "**已经定下的每一条都要有出处。**", "**废弃一页。**", "**提到。**"]) assert.ok(ten.includes(word), word);
  // 局部不明白：记问题、标待定、接着做；问题分阻断下游与不阻断；了结时写落实到。字段名与取值同程序里的常量。
  assert.ok(ten.includes("9. **局部不明白时：记问题、标待定，接着做。**"));
  for (const word of [`「${PROBLEM_BLOCKING_FIELD}」必须写`, `「${PROBLEM_BLOCKING}」`, `「${PROBLEM_NOT_BLOCKING}」`, `「${PROBLEM_REVISIT_FIELD}」`, `「${PROBLEM_LANDED_FIELD}」`,
    `图上那个节点的文字以「${PENDING_MARK}：」开头`, "阻断下游的排在最前", "任务定义的问题集合里没有这几个字段时不写它们"]) assert.ok(ten.includes(word), word);
  // 各阶段各自的做法不在这里：它们在六段里，一次只给一段。
  for (const word of ["抓没说清的词", "问为什么", "例外清单", "两种节奏"]) assert.ok(!ten.includes(word), word);
});

test("共用部分的第十二节：随时可用的七项能力各一条，三条通用的规矩；不超过 40 行", () => {
  const twelve = [...sections(read("common.md"))].find(([title]) => title.startsWith(SECTION_TWELVE))![1];
  assert.ok(twelve.startsWith("## 十二、随时可用的七项能力\n"));
  const items = [...twelve.matchAll(/^(\d)\. \*\*([^*]+)\*\*/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(items, ["1 提问与了结。", "2 修订。", "3 确认。", "4 记决定。", "5 复述。", "6 评审。", "7 任务状况。"]);
  assert.deepEqual(twelve.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2, line.indexOf("：") === -1 ? line.indexOf("。") : Math.min(line.indexOf("：") , line.length))),
    ["做这七件事不移动阶段，也不用先发卡片。".slice(0, -1), "做完回到手上的事", "你补的内容一律待核实"]);
  assert.ok(twelve.split("\n").length <= 40, `第十二节现在 ${twelve.split("\n").length} 行`);
});

test("有阶段的任务的系统提示：说明已在下文、不用再读 skill 文件，「现在这个阶段」优先；底线四条与早先那一份相同", () => {
  const system = read("system.md");
  const legacy = readFileSync(join(ROOT, "backend", "prompts", "executor_system_prompt.md"), "utf-8");
  assert.match(system, /这几份说明已经在下文，不用再去读 skill 文件。/);
  assert.match(system, /「现在这个阶段」与前面两份说明不一致时，照「现在这个阶段」做。/);
  assert.doesNotMatch(system, /先用 read 读 taskwright-executor/);
  const bottom = (text: string) => text.slice(text.indexOf("## 底线")).trim();
  assert.equal(bottom(system), bottom(legacy));
});

// ───────────── 六个阶段各一段 ─────────────

/** 六段的最后一节都叫这个名字：用户说的话按落在哪里分几种处理（落在这一段的照做，落在别的阶段而这一段做得了的直接做）。 */
const MODELING_LAST_HEADING = "用户说的话不属于本段时";
const STAGE_HEADINGS = ["这一段做什么", "这一段不做什么", "做到什么算够", "出口", MODELING_LAST_HEADING];
const lastHeading = (_stage: Stage) => MODELING_LAST_HEADING;

test("六个阶段各有一段：文件名是阶段的键，标题写阶段的名字，都按同样的五个小节写", () => {
  for (const stage of STAGES) {
    const text = read(`${stage}.md`);
    assert.ok(text.startsWith(`# 现在这个阶段：${STAGE_NAMES[stage]}\n`), stage);
    assert.ok(text.includes(`任务现在在${STAGE_NAMES[stage]}阶段`), stage);
    assert.deepEqual([...sections(text).keys()], [...STAGE_HEADINGS.slice(0, 4), lastHeading(stage)], stage);
    // 这一段的「算够」里说了去哪里看还差什么。
    assert.ok(sections(text).get("做到什么算够")!.includes("查询任务状态的末尾写着这一段还差什么"), stage);
  }
});

test("每一段的「用户说的话不属于本段时」：先分清落在哪里；落在这一段的照做，落在别的阶段而这一段做不了的说明现在在哪一段，与需求无关的简短作答", () => {
  /** 每条开头到括号或冒号之前的那几个字。 */
  const labels = (stage: Stage) => sections(read(`${stage}.md`)).get(MODELING_LAST_HEADING)!.split("\n").filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2, Math.min(...["（", "："].map((mark) => line.indexOf(mark)).filter((at) => at >= 0))));
  assert.deepEqual(labels("reading"), ["落在这一段", "落在后面的阶段", "与这件需求无关"]);
  for (const stage of ["clarifying", "modeling", "writing"] as const) assert.deepEqual(labels(stage), ["落在这一段", "落在前面的阶段", "落在后面的阶段", "与这件需求无关"], stage);
  assert.deepEqual(labels("reviewing"), ["落在这一段", "落在前面的阶段、这一段写得了的", "落在前面的阶段、这一段写不了的", "落在后面的阶段", "与这件需求无关"]);
  assert.deepEqual(labels("document"), ["落在这一段", "落在前面的阶段、改的是主题页", "落在前面的阶段、改的是条目或图", "与这件需求无关"]);
  for (const stage of STAGES) {
    const outside = sections(read(`${stage}.md`)).get(MODELING_LAST_HEADING)!;
    assert.ok(outside.includes("用户随时可以说任何话。先分清他说的事落在哪里"), stage);
    const cases = outside.split("\n").filter((line) => line.startsWith("- "));
    assert.ok(cases[0].includes("照做"), stage);
    assert.ok(cases.at(-1)!.endsWith("与这件需求无关：简短作答，回到手上的事。"), stage);
    // 这一段做不了的事：说明任务现在在哪一段。
    assert.ok(outside.includes(`任务现在在${STAGE_NAMES[stage]}阶段`) || stage === "reviewing", stage);
    // 不再教助手在回复里写 stage。
    assert.doesNotMatch(read(`${stage}.md`), /`stage`/, stage);
  }
  // 写条目之前的三段：用户要写条目时发那张卡片，由用户点。
  for (const stage of ["reading", "clarifying", "modeling"] as const) {
    assert.ok(sections(read(`${stage}.md`)).get(lastHeading(stage))!.includes("发「开始写条目」的卡片，由用户点"), stage);
  }
});

test("整理建模那一段的「用户说的话不属于本段时」：分四种处理，落在前面阶段的事直接做，落在后面阶段的事发卡片", () => {
  const outside = sections(read("modeling.md")).get(MODELING_LAST_HEADING)!;
  const cases = outside.split("\n").filter((line) => line.startsWith("- "));
  assert.deepEqual(cases.map((line) => line.slice(2, line.indexOf("（") === -1 ? line.indexOf("：") : Math.min(line.indexOf("（"), line.indexOf("：")))),
    ["落在这一段", "落在前面的阶段", "落在后面的阶段", "与这件需求无关"]);
  assert.ok(cases[0].endsWith("照做。"));
  assert.ok(cases[1].includes("直接改相应的主题页并写上来源，不用退回") && cases[1].includes("跟着改图"));
  assert.ok(cases[1].includes("它引出的疑问记成问题条目，不退回") && cases[1].includes("发提议退回核读材料的卡片（第十节第 2 条），由用户点"));
  assert.ok(cases[2].includes("用一句话说明任务现在在整理建模阶段、下一段要做什么") && cases[2].includes("用户打字说可以不算"));
  assert.ok(cases[3].includes("简短作答，回到手上的事"));
});

test("整理建模那一段：主动画五种图并写明第十一节第 1 条对这一段不适用；固定的七步；算够的七件与灯的数目相同", () => {
  const text = read("modeling.md");
  assert.ok(text.includes("这一段你主动画图，不等用户提出，也不用先提议：第十一节第 1 条「用户提出时画、先提议再画」对这一段不适用。"));
  assert.ok(read("common.md").includes("整理建模阶段例外：这一段你主动把五种图画出来，不等用户提出，也不用先提议，见「现在这个阶段」。"));
  const steps = [...sections(text).get("这一段做什么")!.matchAll(/^(\d)\. \*\*([^*]+)\*\*/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(steps, ["1 先画系统边界图（context）。", "2 再画用例图（use_case）。", "3 再画对象关系图（class）。", "4 每一页流程画一张流程图（flowchart）。",
    "5 有状态的概念各画一张状态图（state）。", "6 把各页「已经定下的」通读一遍，找互相矛盾的规则。", "7 汇报。"]);
  for (const words of [`「事项」以「${RULE_CONFLICT_PREFIX}」开头`, "每张图的节点文字最前面写它画的那一页的编号，来源写它画自的页",
    "在用的页还没贴标签、或者没有上级主题的，这时贴上或建议", "并请用户把这几张图看一遍"]) assert.ok(text.includes(words), words);
  const enough = sections(text).get("做到什么算够")!;
  assert.ok(enough.startsWith("## 做到什么算够\n\n七件："));
  assert.equal(enough.slice(enough.indexOf("七件：")).split("。")[0].split("；").length, 7);
  assert.equal(stageLamps(EMPTY_LAMP_INPUT).modeling.length, 7);
  // 写条目那一段：算够的六件与灯的数目相同，条目可以依据图。
  const writing = sections(read("writing.md"));
  assert.ok(writing.get("做到什么算够")!.includes("六件：") && writing.get("做到什么算够")!.includes("每个条目依据的图都是用户看过的"));
  assert.ok(writing.get("做到什么算够")!.includes("没有还没了结的阻断下游的问题") && writing.get("做到什么算够")!.includes("没有还标着「待定」的地方"));
  assert.equal(stageLamps(EMPTY_LAMP_INPUT).writing.length, 6);
  assert.ok(writing.get("这一段做什么")!.includes("条目也可以依据整理建模阶段画的图：来源种类写「图」，出处写图的编号"));
});

test("每一段的「出口」：往前都是发卡片由用户点，两个选项的键与文字同程序里的常量；没有自己移动阶段的说法；局部不明白不退回，大面积不能用才发回退卡片", () => {
  for (const stage of STAGES.filter((one) => one !== "document")) {
    const exit = sections(read(`${stage}.md`)).get("出口")!;
    const enter = ENTER_OPTIONS[nextStage(stage) as Exclude<Stage, "reading">], stay = STAY_OPTIONS[stage as Exclude<Stage, "document">];
    assert.ok(exit.includes(`\`${enter.key}\`「${enter.text}」、\`${stay.key}\`「${stay.text}」`), stage);
    assert.ok(exit.includes("用请选择提议进入"), stage);
    assert.match(exit, /你不能自己把任务(移到|往前移)/, stage);
  }
  // 澄清那一段另有「开始写条目」的卡片：留在这一段的选项是继续本阶段。
  assert.ok(sections(read("clarifying.md")).get("出口")!.includes("`start_items`「开始写条目」、`continue_clarify`「继续本阶段」"));
  for (const stage of STAGES) {
    const text = read(`${stage}.md`);
    assert.doesNotMatch(text, /自己移到(澄清|整理建模|写条目|评审确认|编写文档)[：，]/, stage);
    assert.doesNotMatch(text, /在(同一次)?回复里写 `stage`/, stage);
  }
  // 评审确认不主动提议；澄清不催用户，但没有要问的了就照常提议、不停着等；别的几段做完才提议。
  assert.ok(sections(read("reviewing.md")).get("出口")!.includes("这一段你不主动提议进入下一段。只在两种情形发卡片：用户问起"));
  const clarifyExit = sections(read("clarifying.md")).get("出口")!;
  assert.ok(clarifyExit.includes("这一段不催用户：用户还在说、你还有要问的事时，不提议进入下一段。"));
  assert.ok(clarifyExit.includes("剩下没了结的问题都是用户答不上的、用户说先保留的、或者不阻断的。第二种情形照常提议，不要停着等用户开口：每次回复的末尾，要么是下一个问题，要么是这张卡片。"));
  for (const stage of ["reading", "clarifying", "modeling", "writing", "document"] as const) assert.ok(!read(`${stage}.md`).includes("不主动提议"), stage);
  // 澄清：材料没写而业务必需的规则也要问；答案直接记、答完的几条一张卡片一起了结；答不上的记问题、不追问；不凭一句泛泛的话立目标页。
  const clarifyDo = sections(read("clarifying.md")).get("这一段做什么")!;
  assert.ok(clarifyDo.includes("二是这件业务要运转起来必须有、而材料没有写的规则"));
  assert.ok(clarifyDo.includes("不要每记一条就发一张「是否已解决」的卡片：在下一问的开头用一句话带过，答完的几条到最后用一张卡片一起问（第五节第 8 条）"));
  assert.ok(clarifyDo.includes("记下之后不要换个问法再问同一件事"));
  assert.ok(clarifyDo.includes("不立目标页，也不再追问"));
  // 共用部分：答完的几条一张卡片一起问；进入卡片只点名最要紧的几个；待定的记号只有一种。
  const common = read("common.md");
  assert.ok(common.includes("用一张这样的卡片把已经答完的几条一起问，`items` 点名这几条问题条目"));
  assert.ok(common.includes("只点名最要紧的几个，一般不超过六个"));
  assert.ok(common.includes("不要写成「待澄清」「未定」「TBD」或一个问号，程序只认「待定」两个字"));
  // 局部不明白不退回；整理建模、写条目两段写明大面积不能用时发回退卡片。
  assert.ok(sections(read("modeling.md")).get("出口")!.includes("不要退回，也不要停下来等。照第十节第 9 条记一条问题条目，在图上那一处标「待定：」，接着画别的"));
  assert.ok(sections(read("modeling.md")).get("出口")!.includes("发提议退回澄清的卡片（第十节第 2 条），由用户点"));
  assert.ok(sections(read("writing.md")).get("出口")!.includes("只是一处不明白：照上面第 3 条记问题、标待定，接着写别的"));
  assert.ok(sections(read("writing.md")).get("出口")!.includes("发提议退回澄清或整理建模的卡片（第十节第 2 条），由用户点"));
  // 进入下一段的卡片里列出没了结的问题，阻断下游的排最前。
  for (const stage of ["reading", "clarifying", "modeling", "writing"] as const) assert.ok(sections(read(`${stage}.md`)).get("出口")!.includes("阻断下游的"), stage);
});

test("每一段的「不做什么」与工具守的一致：这一段不能写的东西都写了", () => {
  const WORDS: Record<Exclude<WriteKind, "page" | "problem">, string> = { diagram: "不画图", item: "不写别的集合的条目", review: "不请求评审", complete: "不完成任务" };
  for (const stage of STAGES) {
    const not = sections(read(`${stage}.md`)).get("这一段不做什么")!;
    for (const [kind, word] of Object.entries(WORDS) as [WriteKind, string][]) {
      assert.equal(not.includes(word), !canWrite(stage, kind), `${stage}：${word}`);
    }
  }
  // 评审确认阶段主题页只能改两处。
  assert.ok(sections(read("reviewing.md")).get("这一段不做什么")!.includes("只能改「状态」与「改看」两处"));
});

test("核读材料那一段：一轮最多 12 页，用一小段话说清材料讲的是什么，对不上的各记一条问题，立完页发「进入澄清」的卡片并说出第一个要问的问题", () => {
  const text = read("reading.md");
  assert.ok(text.includes("一轮最多立 12 页"));
  assert.ok(text.includes("用一小段话说清三件事：材料讲的是什么业务、要改变什么、最大的不确定是什么"));
  assert.ok(text.includes("材料之间互相矛盾，或者材料与知识库里的规定对不上，每一处记一条问题条目"));
  assert.ok(text.includes("再说进入澄清之后你要问的第一件事"));
  assert.ok(text.includes("你不能自己把任务移到澄清。"));
  assert.ok(text.includes("不向用户提问。"));
});

test("澄清那一段：提问的优先次序与六种问法；举的提问例句都是开放问题，过得了回复工具的那条规则", () => {
  const text = read("clarifying.md");
  assert.ok(text.includes("目标之间的矛盾，先于谁负责什么、做到哪里为止，先于场景与例外，先于规则之间的冲突，先于指标（多快、多少），先于细节"));
  for (const way of ["开放式", "因果追问", "具体情境", "边界反例", "对比选择", "复述确认"]) assert.ok(text.includes(`   - ${way}：`), way);
  const examples = [...text.matchAll(/用提问。例如「([^」]+)」/g)].map((m) => m[1]);
  assert.equal(examples.length, 4);
  for (const one of examples) assert.equal(closedQuestion(one), false, one);
});

test("整理建模那一段：例外清单八种，例外的例子以「例外：」开头", () => {
  const text = read("modeling.md");
  assert.ok(text.includes("取消、重复、权限不足、无输入、输入冲突、超时、人工介入、外部依赖不可用"));
  assert.ok(text.includes(`以「${EXCEPTION_EXAMPLE_PREFIX}」开头的例子`));
});

test("写条目与评审确认两段：依据用户看过的页、写完发「进入评审确认」的卡片；评审确认阶段提议进入编写文档，用户不写文档时完成任务", () => {
  const writing = read("writing.md");
  assert.ok(writing.includes("只依据贴了标签、用户看过的页"));
  assert.ok(writing.includes("你不能自己把任务移到评审确认。"));
  const reviewing = read("reviewing.md");
  assert.ok(reviewing.includes("用户选了现在完成，再调用完成任务"));
  // 评审确认不再是最后一段：完成条件都满足之后提议进入编写文档；用户明说不写文档时才问是否完成。
  assert.ok(reviewing.includes("3. **条件都满足之后提议进入编写文档。**") && reviewing.includes("用户明说不写文档、要直接完成时"));
});

test("卡片之外的话先判断是不是在回答卡片；搁下的卡片不催，提议进入下一段之前一次一张重发；说明里用的名字与程序写的一致", () => {
  const common = sections(read("common.md"));
  const section = (title: string) => [...common.entries()].find(([name]) => name.startsWith(title))![1];
  // 第一节与第八节：卡片文本框里打的字前面的那条说明、它要写理解；开头几个字与扩展写的相同。
  assert.ok(section("一、").includes(`以「${CARD_TYPED_PREFIX}」开头的说明`));
  assert.ok(section("八、").includes(`用户在卡片的文本框里打的字不在此列：它前面的说明以「${CARD_TYPED_PREFIX}」开头，那是用户自己的话，要写理解。`));
  // 第九节：先判断，是就写 responds_to，不是就搁下；重发写 resends。
  const facts = section("九、");
  for (const said of ["不一定是在回答卡片，先按上下文判断", "理解里 `responds_to` 指向它，页面据此把那张卡片显示为答过", "那张卡片算暂时搁下",
    "搁下的卡片不要催，不要紧跟着重发，也不要当作用户已经同意", "`act` 里写 `resends`（值是它的编号，只有提问与请选择可以重发）", "提议的卡片不重发"]) {
    assert.ok(facts.includes(said), `第九节应当写着「${said}」`);
  }
  // 第十节第 3 条：发进入下一段的卡片之前看任务状态最后一行，一次一张重发，仍不答的记问题条目，重发过一次的不再重发。
  const stages = section(SECTION_TEN);
  const line = openCardsLine([{ act_id: "r3-2", function: "ask", summary: "借阅期限是多少天", event_seq: 9 }]);
  const named = /^(这一段还开着的提问与请选择)/.exec(line)![1];
  for (const said of [`先用查询任务状态看最后一行「${named}」`, "先把它们一次一张重发，这时不提议进入下一段", "这个问题前面没有答，这一段结束前请确认",
    "照第 9 条记成问题条目，写明「阻断下游」或「不阻断」；重发过一次的不再重发。全部过完，才发进入下一段的卡片。"]) {
    assert.ok(stages.includes(said), `第十节应当写着「${said}」`);
  }
  assert.ok(section(SECTION_TWELVE).includes("这一段还有哪几张提问与请选择的卡片用户没有答"));
});

test("共用部分第五节新加的那个反例标明了它是错的写法", () => {
  assert.ok(read("common.md").includes("是错的：提问的卡片上没有可点的选项"));
});

// ───────────── 任务类型一级：需求规格任务 ─────────────

const SRS_SKILL = join(ROOT, "task-types", "srs-authoring", ".pi", "skills", "srs-authoring");

test("需求规格任务的说明拆成四份：SKILL.md 只留每个阶段都要用的，核读材料、写条目与编写文档各有一段，别的阶段没有文件", () => {
  const common = body(readFileSync(join(SRS_SKILL, "SKILL.md"), "utf-8"));
  // 「材料里的内容都要整理进条目」这句只在写条目那一段里：核读材料与澄清阶段不该有写条目的要求。
  assert.doesNotMatch(common, /都要整理进条目/);
  assert.doesNotMatch(common, /分拣成/);
  assert.doesNotMatch(common, /一批最多写 4 个条目/);
  for (const head of ["1. **材料没按块读完不要动笔。**", "2. **含糊的地方不要自己定。**", "3. **问用户与记下答复。**", "4. **「用户决定保留」只认对话里的用户。**",
    "5. **用户的说法与材料原文对不上时**", "6. **总体分析的每一页怎样填。**"]) assert.ok(common.includes(head), head);
  assert.deepEqual(readdirSync(join(SRS_SKILL, "stages")).sort(), ["document.md", "reading.md", "writing.md"]);
  const document = readFileSync(join(SRS_SKILL, "stages", "document.md"), "utf-8");
  assert.ok(document.startsWith("## 这类任务在编写文档阶段\n"));
  for (const words of ["概述与范围那一章的导语写三段。背景：", "读者对象：", "范围边界：", "导语只概括各节与已经确认的条目里写下的内容，不写新的规定", "来源写「助手补充」",
    "一次保存最多写 4 页", "「是否阻断下游」照实写，不要改条目"]) assert.ok(document.includes(words), words);
  for (const chapter of CHAPTERS.slice(1)) assert.ok(document.includes(`${chapter.name}：`), chapter.name);
  const reading = readFileSync(join(SRS_SKILL, "stages", "reading.md"), "utf-8");
  assert.ok(reading.startsWith("## 这类任务在核读材料阶段\n"));
  assert.ok(reading.includes("一轮最多 12 页"));
  assert.ok(reading.includes("这几批里不要夹着用例、需求或约束"));
  const writing = readFileSync(join(SRS_SKILL, "stages", "writing.md"), "utf-8");
  assert.ok(writing.startsWith("## 这类任务在写条目阶段\n"));
  for (const head of ["整理建模阶段画出的图与材料里的内容都要整理进条目", "1. **照图写条目。**", "2. **每条功能用例的来源写两张图。**", "3. **非功能需求不经图。**",
    "4. **含糊的记成问题。**", "5. **一批最多写 4 个条目，问题条目放最后一批。**", "6. **一句话既是解释又是规则时。**", "7. **写完对用户说话。**"]) {
    assert.ok(writing.includes(head), head);
  }
  // 从图到条目的对应：五种图都说到了，功能用例的八个字段都有着落（字段名与任务定义里的相同）。
  const mapping = writing.slice(writing.indexOf("1. **照图写条目。**"), writing.indexOf("2. **每条功能用例的来源写两张图。**"));
  for (const kind of ["用例图", "流程图", "状态图", "对象关系图", "系统边界图"]) assert.ok(mapping.includes(kind), kind);
  const definition = JSON.parse(readFileSync(join(ROOT, "task-types", "srs-authoring", "docs", "task-definitions", "srs-authoring.json"), "utf-8"));
  const useCase = definition.交付物.条目集合.find((one: { 名称: string }) => one.名称 === "功能用例");
  assert.equal(useCase.字段.length, 8);
  for (const field of useCase.字段 as { 名: string }[]) assert.ok(mapping.includes(`「${field.名}」`), field.名);
  assert.ok(writing.includes("种类写「图」，出处写图的编号（例如 D-002）"));
  assert.ok(writing.includes("任务里只有一张用例图，各条用例都指向它，不要为每条用例另画一张。"));
  assert.ok(writing.includes("这件事不牵涉状态图时，不必为了对应而补写。"));
  // 任务类型的文件名也只用阶段的键。
  for (const name of readdirSync(join(SRS_SKILL, "stages"))) assert.ok((STAGES as readonly string[]).includes(name.replace(/\.md$/, "")), name);
});

test("编写文档那一段：补导语与概括句并写明依据；出口是请用户过目的卡片，不引出运行所以话要一次说完；分四种处理用户的话", () => {
  const text = read("document.md");
  const all = sections(text);
  const steps = [...all.get("这一段做什么")!.matchAll(/^(\d)\. \*\*([^*]+)\*\*/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(steps, ["1 通读。", "2 每章补一页导语。", "3 各节开头补一句概括。", "4 核对术语与说法。", "5 补写的每一处都写明依据。", "6 汇报。"]);
  for (const words of ["「导语所属章」填这一章的章名", "一章只立一页", "任务定义里没有「导语所属章」这个字段时不立导语页", "来源种类写「助手补充」",
    "不要自己挑一个改掉，记一条问题条目"]) assert.ok(all.get("这一段做什么")!.includes(words), words);
  // 七章的章名与程序里的相同。
  for (const chapter of CHAPTERS) assert.ok(all.get("这一段做什么")!.includes(chapter.name), chapter.name);
  const enough = all.get("做到什么算够")!;
  assert.ok(enough.startsWith("## 做到什么算够\n\n三件："));
  assert.equal(enough.slice(enough.indexOf("三件：")).split("。")[0].split("；").length, 3);
  assert.equal(stageLamps(EMPTY_LAMP_INPUT).document.length, 3);
  const exit = all.get("出口")!;
  assert.ok(exit.includes("`document_reviewed`「看过了，生成文档」、`document_revise`「需要修改」"));
  assert.ok(exit.includes("你不会因此再运行一次，所以要说的话在这张卡片上一次说完"));
  assert.ok(exit.includes("不要自己退回，用请选择提议退回并写明原因") && exit.includes("`stay_in_stage`「留在本段」"));
  assert.doesNotMatch(text, /`stage`「/, "这一段不教助手在回复里写 stage");
  const cases = all.get(MODELING_LAST_HEADING)!.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(cases.length, 4);
  assert.ok(cases[0].startsWith("- 落在这一段") && cases[0].endsWith("照做。"));
  assert.ok(cases[1].includes("直接改相应的主题页并写上来源，不用退回"));
  assert.ok(cases[2].includes("用一句话说明任务现在在编写文档阶段") && cases[2].includes("用户打字说可以不算"));
  assert.ok(cases[3].includes("简短作答，回到手上的事"));
});
