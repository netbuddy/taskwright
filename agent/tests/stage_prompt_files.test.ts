/**
 * 有阶段的任务用的说明文件（agent/prompts/stages/）的内容检查。只读这些文件，不改。
 *
 * 平台说明现在有两份：早先的任务经 --skill 读的那一份（agent/prompts/skills/taskwright-executor/SKILL.md），
 * 与有阶段的任务放进系统提示的共用部分（agent/prompts/stages/common.md）。两份的第一到九节与第十一节本应相同，
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
import { RULE_CONFLICT_PREFIX } from "../src/lib/overall_views.ts";
import { ENTER_OPTIONS, type LampInput, STAGES, STAGE_NAMES, STAY_OPTIONS, type Stage, type WriteKind, canWrite, nextStage, stageLamps } from "../src/lib/stage.ts";

/** 一个什么都没有的任务的算灯事实：只用来数每个阶段有几盏灯。 */
const EMPTY_LAMP_INPUT: LampInput = {
  pages: [], items: [], questions: [], collections: [], materials: [], citedDocuments: [], diagrams: [], ruleConflicts: [],
  review: { failing: [], any: false }, completion: { satisfied: false, unmet: [] },
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEGACY = join(ROOT, "agent", "prompts", "skills", "taskwright-executor", "SKILL.md");
const STAGES_DIR = join(ROOT, "agent", "prompts", "stages");
const read = (name: string) => readFileSync(join(STAGES_DIR, name), "utf-8");

/** 两份里不比的那一节：早先那一份的第十节写全部阶段的做法与早先的任务，共用部分的第十节只写各阶段都要用的。 */
const SECTION_TEN = "十、";

/**
 * 有意的改动：早先那一份里的 from（必须正好出现一次），在共用部分里是 to。to 为空串是整段删去。
 */
const EDITS: { why: string; from: string; to: string }[] = [
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
  const titles = (all: Map<string, string>) => [...all.keys()].filter((title) => !title.startsWith(SECTION_TEN));
  assert.deepEqual(titles(common), titles(legacy), "两份的节标题与次序应当相同（第十节除外）");
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

test("共用部分的第十节只写各阶段都要用的：五个阶段、自己只能退回、往前的四张卡片与复述卡片的写法、主题页的四件事", () => {
  const ten = [...sections(read("common.md"))].find(([title]) => title.startsWith(SECTION_TEN))![1];
  for (const name of ["核读材料", "澄清", "整理建模", "写条目", "评审确认"]) assert.ok(ten.includes(name), name);
  for (const word of ["`stage`", "`reason`", "`story_ok`", "`story_fix`", "`story_again`"]) assert.ok(ten.includes(word), word);
  assert.ok(ten.includes("**你自己只能退回。**"));
  assert.ok(ten.includes("往前进入下一个阶段你不能自己做"));
  // 往前的四张卡片：进入下一段与留在这一段两个选项，键与文字同程序里的常量。
  for (const from of ["reading", "clarifying", "modeling", "writing"] as const) {
    const enter = ENTER_OPTIONS[nextStage(from) as Exclude<Stage, "reading">], stay = STAY_OPTIONS[from];
    assert.ok(ten.includes(`\`${enter.key}\`「${enter.text}」、\`${stay.key}\`「${stay.text}」`), from);
  }
  for (const word of ["**待核实。**", "**已经定下的每一条都要有出处。**", "**废弃一页。**", "**提到。**"]) assert.ok(ten.includes(word), word);
  // 各阶段各自的做法不在这里：它们在五段里，一次只给一段。
  for (const word of ["抓没说清的词", "问为什么", "例外清单", "两种节奏"]) assert.ok(!ten.includes(word), word);
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

// ───────────── 五个阶段各一段 ─────────────

const STAGE_HEADINGS = ["这一段做什么", "这一段不做什么", "做到什么算够", "出口", "用户的话落在这一段之外时"];
/** 整理建模那一段的最后一节换了写法：用户说的话按落在哪里分四种处理（落在前面阶段的事直接做）。别的四段还是原来的写法。 */
const MODELING_LAST_HEADING = "用户说的话不属于本段时";
const lastHeading = (stage: Stage) => (stage === "modeling" ? MODELING_LAST_HEADING : STAGE_HEADINGS[4]);

test("五个阶段各有一段：文件名是阶段的键，标题写阶段的名字，都按同样的五个小节写", () => {
  for (const stage of STAGES) {
    const text = read(`${stage}.md`);
    assert.ok(text.startsWith(`# 现在这个阶段：${STAGE_NAMES[stage]}\n`), stage);
    assert.ok(text.includes(`任务现在在${STAGE_NAMES[stage]}阶段`), stage);
    assert.deepEqual([...sections(text).keys()], [...STAGE_HEADINGS.slice(0, 4), lastHeading(stage)], stage);
    // 这一段的「算够」里说了去哪里看还差什么。
    assert.ok(sections(text).get("做到什么算够")!.includes("查询任务状态的末尾写着这一段还差什么"), stage);
  }
});

test("每一段都写明用户的话落在这一段之外时怎么办：不照办、不复述求同意，说明现在在哪一段与怎样过去", () => {
  for (const stage of STAGES.filter((one) => one !== "modeling")) {
    const outside = sections(read(`${stage}.md`)).get("用户的话落在这一段之外时")!;
    assert.ok(outside.includes("不要照办，也不要把用户的话复述一遍求同意"), stage);
    assert.ok(outside.includes(`再在回复里说清任务现在在${STAGE_NAMES[stage]}阶段、那件事`), stage);
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
  assert.ok(cases[1].includes("退回核读材料，在回复里写 `stage`「核读材料」与 `reason`"));
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
  // 写条目那一段：算够的四件与灯的数目相同，条目可以依据图。
  const writing = sections(read("writing.md"));
  assert.ok(writing.get("做到什么算够")!.includes("四件：") && writing.get("做到什么算够")!.includes("每个条目依据的图都是用户看过的"));
  assert.equal(stageLamps(EMPTY_LAMP_INPUT).writing.length, 4);
  assert.ok(writing.get("这一段做什么")!.includes("条目也可以依据整理建模阶段画的图：来源种类写「图」，出处写图的编号"));
});

test("每一段的「出口」：往前都是发卡片由用户点，两个选项的键与文字同程序里的常量；没有「自己往前移」的说法；回退仍可以自己做", () => {
  for (const stage of ["reading", "clarifying", "modeling", "writing"] as const) {
    const exit = sections(read(`${stage}.md`)).get("出口")!;
    const enter = ENTER_OPTIONS[nextStage(stage) as Exclude<Stage, "reading">], stay = STAY_OPTIONS[stage];
    assert.ok(exit.includes(`\`${enter.key}\`「${enter.text}」、\`${stay.key}\`「${stay.text}」`), stage);
    assert.ok(exit.includes("用请选择提议进入"), stage);
    assert.match(exit, /你不能自己把任务(移到|往前移)/, stage);
  }
  // 澄清那一段另有「开始写条目」的卡片：留在这一段的选项是继续本阶段。
  assert.ok(sections(read("clarifying.md")).get("出口")!.includes("`start_items`「开始写条目」、`continue_clarify`「继续本阶段」"));
  for (const stage of STAGES) {
    const text = read(`${stage}.md`);
    assert.doesNotMatch(text, /自己移到(澄清|整理建模|写条目|评审确认)[：，]/, stage);
    // 往前的阶段名不出现在「写 stage」的句子里：能写进 stage 的只有前面的阶段。
    for (const later of STAGES.slice(STAGES.indexOf(stage) + 1)) assert.ok(!text.includes(`\`stage\`「${STAGE_NAMES[later]}」`), `${stage}：${later}`);
  }
  // 回退：整理建模可以退回澄清，澄清可以退回核读材料。
  assert.ok(read("modeling.md").includes("退回澄清，在同一次回复里写 `stage`「澄清」与 `reason`"));
  assert.ok(read("clarifying.md").includes("退回核读材料，在回复里写 `stage`「核读材料」与 `reason`"));
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

test("写条目与评审确认两段：依据用户看过的页、写完发「进入评审确认」的卡片；评审确认阶段完成任务", () => {
  const writing = read("writing.md");
  assert.ok(writing.includes("只依据贴了标签、用户看过的页"));
  assert.ok(writing.includes("你不能自己把任务移到评审确认。"));
  const reviewing = read("reviewing.md");
  assert.ok(reviewing.includes("用户选了现在完成，再调用完成任务"));
});

test("共用部分第五节新加的那个反例标明了它是错的写法", () => {
  assert.ok(read("common.md").includes("是错的：提问的卡片上没有可点的选项"));
});

// ───────────── 任务类型一级：需求规格任务 ─────────────

const SRS_SKILL = join(ROOT, "task-types", "srs-authoring", ".pi", "skills", "srs-authoring");

test("需求规格任务的说明拆成三份：SKILL.md 只留每个阶段都要用的，核读材料与写条目各有一段，别的阶段没有文件", () => {
  const common = body(readFileSync(join(SRS_SKILL, "SKILL.md"), "utf-8"));
  // 「材料里的内容都要整理进条目」这句只在写条目那一段里：核读材料与澄清阶段不该有写条目的要求。
  assert.doesNotMatch(common, /都要整理进条目/);
  assert.doesNotMatch(common, /分拣成/);
  assert.doesNotMatch(common, /一批最多写 4 个条目/);
  for (const head of ["1. **材料没按块读完不要动笔。**", "2. **含糊的地方不要自己定。**", "3. **问用户与记下答复。**", "4. **「用户决定保留」只认对话里的用户。**",
    "5. **用户的说法与材料原文对不上时**", "6. **总体分析的每一页怎样填。**"]) assert.ok(common.includes(head), head);
  assert.deepEqual(readdirSync(join(SRS_SKILL, "stages")).sort(), ["reading.md", "writing.md"]);
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
