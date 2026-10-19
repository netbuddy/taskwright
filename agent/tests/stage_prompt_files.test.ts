/**
 * 有阶段的任务用的说明文件的内容检查：系统提示（agent/prompts/system.md）、平台说明的能力模块（agent/prompts/capabilities/）、
 * 六份活动模板（agent/prompts/templates/）与需求分析流程的定义。只读这些文件，不改。
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
import { type LampInput, PENDING_MARK, STAGES, STAGE_NAMES, type Stage, type WriteKind, canWrite, nextStage, stageLamps } from "../src/lib/stage.ts";
import { NO_PROPOSAL_LINE, openCardsLine } from "../src/lib/stage_proposal.ts";
import { skillBody, withoutSection } from "../src/lib/context_assemble.ts";
import { moduleText, platformText } from "./platform_text.ts";
import { SRS_SKILL_DIR } from "./helpers.ts";
import { CARD_TYPED_PREFIX } from "../src/lib/dialogue_acts.ts";
import { readDefinitions } from "../src/lib/activity_def_read.ts";
import { SRS_SKILL_DIR as SKILL_DIR_FOR_ALLOWED } from "./helpers.ts";

/** 获准能力表：取真实任务类型的活动声明生成的那一份。 */
const ALLOWED = readDefinitions(SKILL_DIR_FOR_ALLOWED).allowed;

/** 一个什么都没有的任务的算灯事实：只用来数每个阶段有几盏灯。 */
const EMPTY_LAMP_INPUT: LampInput = {
  pages: [], items: [], questions: [], collections: [], materials: [], citedDocuments: [], diagrams: [], ruleConflicts: [],
  review: { failing: [], any: false }, completion: { satisfied: false, unmet: [] },
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROMPTS_DIR = join(ROOT, "agent", "prompts");
const TEMPLATES_DIR = join(ROOT, "agent", "prompts", "templates");
/**
 * 读一份说明文件：common.md 是平台说明的模块接起来的整份，六项活动的名字读活动模板，别的读 agent/prompts 目录。开头的头都去掉。
 */
const readRaw = (name: string) => {
  if (name === "common.md") return platformText();
  const stage = STAGES.find((one) => name === `${one}.md`);
  return skillBody(readFileSync(join(stage ? TEMPLATES_DIR : PROMPTS_DIR, name), "utf-8"));
};
/** 任务类型里各项活动的文件（活动声明之后的正文）：这类任务在这一步另外要做的事，含这一步怎样收尾的那一节。 */
const ACTIVITY_DIR = join(ROOT, "task-types", "requirements-engineering", ".pi", "skills", "requirements-engineering", "activities");
const ENDING = "这一步怎样收尾";
const activityBody = (stage: Stage) => skillBody(readFileSync(join(ACTIVITY_DIR, `${stage}.md`), "utf-8"));
/**
 * 读一份说明文件。六项活动的名字读出来的是这一步在需求分析流程里拼出来的那几段：活动模板（做什么、不做什么、做到什么算够）
 * 接上任务类型活动文件里收尾的那一节。别的文件原样。
 */
const read = (name: string) => {
  const stage = STAGES.find((one) => name === `${one}.md`);
  return stage ? `${readRaw(name).trimEnd()}\n\n${sections(activityBody(stage)).get(ENDING)!}\n` : readRaw(name);
};

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

test("共用部分不带 frontmatter，不提早先的任务，理解格式那一段由同一个脚本生成", () => {
  const text = read("common.md");
  assert.ok(text.startsWith("# 在 Taskwright 里怎样工作\n"));
  assert.doesNotMatch(text, /领域说明|老任务|早先建的任务/);
  assert.doesNotMatch(text, /<!--/);
  assert.equal(renderDocument(text), text, "模块里的理解格式生成区过期了，跑 node scripts/render-intent-schema.mjs");
});

test("工作的阶段、转移、复述、业务说明的页、问题条目几个模块只写各阶段都要用的：六个阶段、转移由用户点、开着的提议、复述卡片、主题页的四件事、局部不明白时怎么办", () => {
  const ten = ["stage_cards", "flow_transitions", "retell", "pages_full", "problems"].map(moduleText).join("\n\n");
  for (const name of STAGES.map((one) => STAGE_NAMES[one])) assert.ok(ten.includes(name), name);
  assert.ok(ten.includes("**工作分六个阶段。**"));
  assert.ok(ten.includes("**转移不由你做。**"));
  assert.ok(!ten.includes("`stage` 与 `reason`"), "回复的参数里已经没有这两项，不再提它们");
  assert.ok(ten.includes("这一步要用的东西大面积不能用了，例如用户放进了新材料，或者几页主题的理解互相矛盾"));
  assert.ok(!ten.includes("你自己只能退回"));
  // 开着的提议：从哪里知道、开着时怎么办。
  assert.ok(ten.includes("写着「开着的提议」时，用户说要进入、要退回或者说看过了，请他点输入框上方「待决定」一行里的按钮，不要重发同一张卡片"));
  assert.ok(ten.includes(NO_PROPOSAL_LINE.replace("。", "")));
  for (const word of ["`story_ok`", "`story_fix`", "`story_again`"]) assert.ok(ten.includes(word), word);
  for (const word of ["**待核实。**", "**已经定下的每一条都要有出处。**", "**废弃一页。**", "**提到。**"]) assert.ok(ten.includes(word), word);
  assert.ok(ten.includes("**局部不明白时：记问题、标待定，接着做。**"));
  for (const word of [`「${PROBLEM_BLOCKING_FIELD}」必须写`, `「${PROBLEM_BLOCKING}」`, `「${PROBLEM_NOT_BLOCKING}」`, `「${PROBLEM_REVISIT_FIELD}」`, `「${PROBLEM_LANDED_FIELD}」`,
    `图上那个节点的文字以「${PENDING_MARK}：」开头`, "阻断下游的排在最前", "任务定义的问题集合里没有这几个字段时不写它们"]) assert.ok(ten.includes(word), word);
  for (const word of ["抓没说清的词", "问为什么", "例外清单", "两种节奏"]) assert.ok(!ten.includes(word), word);
  // 复述卡片在逐项对话的活动里都有（含单项活动与空闲），不只在工作流里。
  assert.match(readFileSync(join(ROOT, "agent", "prompts", "capabilities", "dialogue", "retell.md"), "utf-8"), /\nwhen: mode=dialogue\n/);
});

test("「随时可用的七项能力」一节已删去；其中「记决定」与「你补的内容一律待核实」两句并进业务说明的页", () => {
  assert.ok(!platformText().includes("随时可用的七项能力"));
  const pages = moduleText("pages_full");
  assert.ok(pages.includes("5. **记决定。** 用户拍了板时用：立一页主题记下这个决定（贴哪个标签见任务类型说明），写清定了什么、为什么，上级主题写它为的那一页；用户没说为什么就问一句。"));
  // 标签的取值与含义在任务类型说明里，平台模块不列。
  assert.ok(pages.includes("主题分哪几种、标签的取值与含义，见任务类型说明。") && !pages.includes("标签为「决定」"));
  assert.ok(pages.includes("6. 你补的内容一律待核实：用户没有确认之前不算定下，不要拿它当依据。"));
});

test("有阶段的任务的系统提示：说明已在下文、不用再读 skill 文件，「现在这个阶段」优先；末尾是底线一节", () => {
  const system = read("system.md");
  assert.match(system, /这几份说明已经在下文，不用再去读 skill 文件。/);
  assert.match(system, /「现在这个阶段」与平台说明、任务类型说明不一致时，照「现在这个阶段」做。/);
  assert.doesNotMatch(system, /先用 read 读 taskwright-executor/);
  assert.match(system, /\n## 底线\n/);
});

// ───────────── 六个阶段各一段 ─────────────

const STAGE_HEADINGS = ["这一段做什么", "这一段不做什么", "做到什么算够"];

test("活动模板只有做什么、不做什么、做到什么算够；工作流的声明没有正文；这一步怎样收尾写在任务类型的活动文件里", () => {
  for (const stage of STAGES) {
    const template = readRaw(`${stage}.md`);
    assert.ok(template.startsWith(`# 现在这个阶段：${STAGE_NAMES[stage]}\n`), stage);
    assert.ok(template.includes(`任务现在在${STAGE_NAMES[stage]}阶段`), stage);
    assert.deepEqual([...sections(template).keys()], STAGE_HEADINGS, stage);
    assert.ok(sections(template).get("做到什么算够")!.includes("查询任务状态的末尾写着这一段还差什么"), stage);
    assert.doesNotMatch(template, /^## 出口$|^## 用户说的话不属于本段时$/m, stage);
    assert.ok(sections(activityBody(stage)).has(ENDING), stage);
  }
  const flow = readFileSync(join(ACTIVITY_DIR, "..", "flows", "analysis.md"), "utf-8");
  assert.equal(skillBody(flow).trim(), "", "流程文件只有声明");
});

test("工作流里的转移只写一次，在 planning/flow_transitions：卡片的键是 next_step、goto:<活动标识符>、stay；你不能自己移动；用户的话按落在哪一步分；各步与分工表由程序填", () => {
  const moves = moduleText("flow_transitions");
  for (const said of ["{{flow}}", "{{steps}}", "{{here}}", "{{prev}}", "{{next}}", "{{division}}", "你不能自己把任务移到别的一步", "用户在对话里打字说可以了不算",
    "`goto:<那一步的活动标识符>`「转到：那一步的名字」、`stay`「继续本步」", "`goto:<要退回的那一步的活动标识符>`「回到：那一步的名字」、`stay`「继续本步」",
    "先用查询任务状态看最后一行「这一段还开着的提问与请选择」", "重发过一次的不再重发", "只点名最要紧的几个，一般不超过六个",
    "落在这一步的，照做", "与这件需求无关的，简短作答，回到手上的事"]) assert.ok(moves.includes(said), said);
  // 早先按阶段的固定键一个都不在提示词里。
  for (const stage of STAGES) {
    const text = read(`${stage}.md`);
    assert.doesNotMatch(text, /enter_(reading|clarify|consolidate|review|document)|start_items|back_to_|continue_(reading|clarify|consolidate|writing|review)|stay_in_stage/, stage);
    assert.doesNotMatch(text, /在(同一次)?回复里写 `stage`/, stage);
  }
  assert.doesNotMatch(platformText(), /enter_clarify|start_items|back_to_|stay_in_stage|continue_reading/);
});

test("整理建模那一段：主动画五种图并写明「画图」第 1 条对这一段不适用；固定的七步；算够的七件与灯的数目相同", () => {
  const text = read("modeling.md");
  assert.ok(text.includes("这一段你主动画图，不等用户提出，也不用先提议：「画图」第 1 条「用户提出时画、先提议再画」对这一段不适用。"));
  assert.ok(read("common.md").includes("整理建模阶段例外：这一段你主动把五种图画出来，不等用户提出，也不用先提议，见「现在这个阶段」。"));
  const steps = [...sections(text).get("这一段做什么")!.matchAll(/^(\d)\. \*\*([^*]+)\*\*/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(steps, ["1 先画系统边界图（context）。", "2 再画用例图（use_case）。", "3 再画对象关系图（class）。", "4 每一页流程画一张流程图（flowchart）。",
    "5 有状态的概念各画一张状态图（state）。", "6 把各页「已经定下的」通读一遍，找互相矛盾的规则。", "7 汇报。"]);
  for (const words of [`「事项」以「${RULE_CONFLICT_PREFIX}」开头`, "每张图的节点文字最前面写它画的那一页的编号，来源写它画自的页",
    "在用的页还没贴标签、或者没有上级主题的，这时贴上或建议", "并在成文的话里告诉用户先看哪几张图（写图的编号与图名；图不是条目，不写进 `items`）"]) assert.ok(text.includes(words), words);
  const enough = sections(text).get("做到什么算够")!;
  assert.ok(enough.startsWith("## 做到什么算够\n\n七件："));
  assert.equal(enough.slice(enough.indexOf("七件：")).split("。")[0].split("；").length, 7);
  assert.equal(stageLamps(EMPTY_LAMP_INPUT).modeling.length, 7);
  // 写条目那一段：算够的六件与灯的数目相同，条目可以依据图。
  const writing = sections(read("writing.md"));
  assert.ok(writing.get("做到什么算够")!.includes("六件：") && writing.get("做到什么算够")!.includes("每个条目依据的图都是用户看过的"));
  assert.ok(writing.get("做到什么算够")!.includes("没有还没了结的阻断下游的问题") && writing.get("做到什么算够")!.includes("没有还标着「待定」的地方"));
  assert.equal(stageLamps(EMPTY_LAMP_INPUT).writing.length, 6);
  // 条目怎样依据页与图写，挪进了平台说明的模块「条目的写法」。
  assert.ok(moduleText("items_full").includes("条目也可以依据整理建模阶段画的图：来源种类写「图」，出处写图的编号"));
});

test("每一步怎样收尾：做完了提议进入下一步；评审确认不主动提议，澄清不催用户；局部不明白不退回，大面积不能用才提议回到前面的一步", () => {
  for (const stage of ["reading", "clarifying", "modeling", "writing", "reviewing"] as const) assert.ok(sections(read(`${stage}.md`)).get(ENDING)!.includes("提议进入下一步"), stage);
  assert.ok(sections(read("reviewing.md")).get(ENDING)!.includes("这一步你不主动提议进入下一步。只在两种情形发卡片：用户问起"));
  const clarifyExit = sections(read("clarifying.md")).get(ENDING)!;
  assert.ok(clarifyExit.includes("这一步不催用户：用户还在说、你还有要问的事时，不提议进入下一步。"));
  assert.ok(clarifyExit.includes("剩下没了结的问题都是用户答不上的、用户说先保留的、或者不阻断的。第二种情形照常提议，不要停着等用户开口：每次回复的末尾，要么是下一个问题，要么是这张卡片。"));
  for (const stage of ["reading", "clarifying", "modeling", "writing", "document"] as const) assert.ok(!read(`${stage}.md`).includes("不主动提议"), stage);
  const clarifyDo = sections(read("clarifying.md")).get("这一段做什么")!;
  assert.ok(clarifyDo.includes("二是这件业务要运转起来必须有、而材料没有写的规则"));
  assert.ok(clarifyDo.includes("不要每记一条就发一张「是否已解决」的卡片：在下一问的开头用一句话带过，答完的几条到最后用一张卡片一起问（「怎样回复」第 8 条）"));
  assert.ok(clarifyDo.includes("记下之后不要换个问法再问同一件事"));
  assert.ok(clarifyDo.includes("不立目标页，也不再追问"));
  const common = read("common.md");
  assert.ok(common.includes("用一张这样的卡片把已经答完的几条一起问，`items` 点名这几条问题条目"));
  assert.ok(common.includes("不要写成「待澄清」「未定」「TBD」或一个问号，程序只认「待定」两个字"));
  assert.ok(sections(read("modeling.md")).get(ENDING)!.includes("不要退回，也不要停下来等。照「问题条目」记一条问题条目，在图上那一处标「待定：」，接着画别的"));
  assert.ok(sections(read("modeling.md")).get(ENDING)!.includes("前面理出来的页大面积对不上、图画不下去：提议回到前面负责理清这些页的那一步（按分工表）。"));
  // 活动的文字不点名别的步：要回去时按分工表说负责那件事的那一步。
  for (const stage of STAGES) assert.doesNotMatch(sections(read(`${stage}.md`)).get(ENDING)!, /提议(回到|进入)(核读材料|澄清|整理建模|写条目|评审确认|编写文档)/, stage);
  assert.ok(sections(read("writing.md")).get(ENDING)!.includes("只是一处不明白：照上面第 3 条记问题、标待定，接着写别的"));
  assert.ok(sections(read("writing.md")).get(ENDING)!.includes("提议回到前面负责业务说明或分析模型的那一步（按分工表）"));
  for (const stage of ["reading", "clarifying", "modeling", "writing"] as const) assert.ok(sections(read(`${stage}.md`)).get(ENDING)!.includes("阻断下游的"), stage);
});

test("每一段的「不做什么」与工具守的一致：这一段不能写的东西都写了", () => {
  const WORDS: Record<Exclude<WriteKind, "page" | "problem">, string> = { diagram: "不画图", item: "不写别的集合的条目", review: "不请求评审", publish: "不发布版本" };
  for (const stage of STAGES) {
    const not = sections(read(`${stage}.md`)).get("这一段不做什么")!;
    for (const [kind, word] of Object.entries(WORDS) as [WriteKind, string][]) {
      assert.equal(not.includes(word), !canWrite(ALLOWED[stage], kind), `${stage}：${word}`);
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
  assert.ok(text.includes("再说进入下一步之后你要问的第一件事"));
  assert.ok(moduleText("flow_transitions").includes("你不能自己把任务移到别的一步。"));
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

test("写条目与评审确认两段：依据用户看过的页、写完发「进入评审确认」的卡片；评审确认阶段提议进入编写文档，用户不写文档时发布版本", () => {
  const writing = read("writing.md");
  assert.ok(moduleText("items_full").includes("只依据贴了标签、用户看过的页"));
  assert.ok(writing.includes("用户进入之后，你请用户逐条打开看、在界面上点「评审」。"));
  const reviewing = read("reviewing.md");
  assert.ok(reviewing.includes("用户点了「已完成，发布版本」，再调用发布版本"));
  // 评审确认不再是最后一段：完成条件都满足之后提议进入编写文档；用户明说不写文档时才问是否完成。
  assert.ok(reviewing.includes("3. **条件都满足之后提议进入编写文档。**") && reviewing.includes("用户明说不写文档、要直接发布时"));
});

test("卡片之外的话先判断是不是在回答卡片；搁下的卡片不催，提议进入下一段之前一次一张重发；说明里用的名字与程序写的一致", () => {
  // 系统消息与「先写理解」：卡片文本框里打的字前面的那条说明、它要写理解；开头几个字与扩展写的相同。
  assert.ok(moduleText("system_message").includes(`以「${CARD_TYPED_PREFIX}」开头的说明`));
  assert.ok(moduleText("understanding_full").includes(`用户在卡片的文本框里打的字不在此列：它前面的说明以「${CARD_TYPED_PREFIX}」开头，那是用户自己的话，要写理解。`));
  // 三个事实：先判断，是就写 responds_to，不是就搁下；重发写 resends。
  const facts = moduleText("three_facts");
  for (const said of ["不一定是在回答卡片，先按上下文判断", "理解里 `responds_to` 指向它，页面据此把那张卡片显示为答过", "那张卡片算暂时搁下",
    "搁下的卡片不要催，不要紧跟着重发，也不要当作用户已经同意", "`act` 里写 `resends`（值是它的编号，只有提问与请选择可以重发）", "提议的卡片不重发"]) {
    assert.ok(facts.includes(said), `「三个事实怎么用」应当写着「${said}」`);
  }
  // 「各步之间的转移」第 2 条：发进入下一步的卡片之前看任务状态最后一行，一次一张重发，仍不答的记问题条目，重发过一次的不再重发。
  const stages = moduleText("flow_transitions");
  const line = openCardsLine([{ act_id: "r3-2", function: "ask", summary: "借阅期限是多少天", event_seq: 9 }]);
  const named = /^(这一段还开着的提问与请选择)/.exec(line)![1];
  for (const said of [`先用查询任务状态看最后一行「${named}」`, "先把它们一次一张重发，这时不提议进入下一步", "这个问题前面没有答，这一段结束前请确认",
    "照「问题条目」记成问题条目，写明「阻断下游」或「不阻断」；重发过一次的不再重发。全部过完，才发进入下一步的卡片。"]) {
    assert.ok(stages.includes(said), `「各步之间的转移」应当写着「${said}」`);
  }
});

test("共用部分「怎样回复」新加的那个反例标明了它是错的写法", () => {
  assert.ok(read("common.md").includes("是错的：提问的卡片上没有可点的选项"));
});

// ───────────── 任务类型一级：需求规格任务 ─────────────

const SRS_SKILL = join(ROOT, "task-types", "requirements-engineering", ".pi", "skills", "requirements-engineering");

test("需求规格任务的说明拆成四份：SKILL.md 只留每个阶段都要用的，核读材料、写条目与编写文档各有一段，别的阶段没有文件", () => {
  const common = body(readFileSync(join(SRS_SKILL, "SKILL.md"), "utf-8"));
  // 「材料里的内容都要整理进条目」这句只在写条目那一段里：核读材料与澄清阶段不该有写条目的要求。
  assert.doesNotMatch(common, /都要整理进条目/);
  assert.doesNotMatch(common, /分拣成/);
  assert.doesNotMatch(common, /一批最多写 4 个条目/);
  for (const head of ["1. **材料没按块读完不要动笔。**", "2. **问用户与记下答复。**", "3. **用户的说法与材料原文对不上时**", "4. **业务说明的每一页怎样填。**"]) {
    assert.ok(common.includes(head), head);
  }
  // 问题条目的写法与「用户决定保留」只认对话里的用户，挪进了平台说明的模块「问题条目」。
  for (const head of ["1. **含糊的地方不要自己定。**", "2. **「用户决定保留」只认对话里的用户。**"]) assert.ok(moduleText("problems").includes(head), head);
  assert.ok(!common.includes("含糊的地方不要自己定") && !common.includes("只认对话里的用户"));
  // 七项活动各一份声明；六个阶段都有收尾一节，「这类任务在某阶段」的补充只有核读材料、写条目与编写文档三项。
  assert.deepEqual(readdirSync(join(SRS_SKILL, "activities")).sort(), ["clarifying.md", "document.md", "modeling.md", "publish.md", "reading.md", "reviewing.md", "writing.md"]);
  const supplement = (name: string) => withoutSection(body(readFileSync(join(SRS_SKILL, "activities", `${name}.md`), "utf-8")), ENDING).replace(/^\n+/, "");
  assert.deepEqual(STAGES.filter((one) => supplement(one).trim() !== ""), ["reading", "writing", "document"]);
  const document = supplement("document");
  assert.ok(document.startsWith("## 这类任务在编写文档阶段\n"));
  for (const words of ["概述与范围那一章的导语写三段。背景：", "读者对象：", "范围边界：", "导语只概括各节与已经确认的条目里写下的内容，不写新的规定", "来源写「助手补充」",
    "一次保存最多写 4 页", "「是否阻断下游」照实写，不要改条目"]) assert.ok(document.includes(words), words);
  for (const chapter of CHAPTERS.slice(1)) assert.ok(document.includes(`${chapter.name}：`), chapter.name);
  const reading = supplement("reading");
  assert.ok(reading.startsWith("## 这类任务在核读材料阶段\n"));
  assert.ok(reading.includes("一轮最多 12 页"));
  assert.ok(reading.includes("这几批里不要夹着用例、需求或约束"));
  const writing = supplement("writing");
  assert.ok(writing.startsWith("## 这类任务在写条目阶段\n"));
  for (const head of ["整理建模阶段画出的图与材料里的内容都要整理进条目", "1. **照图写条目。**", "2. **每条功能用例的来源写两张图。**", "3. **非功能需求不经图。**",
    "4. **含糊的记成问题。**", "5. **一批最多写 4 个条目，问题条目放最后一批。**", "6. **一句话既是解释又是规则时。**", "7. **写完对用户说话。**"]) {
    assert.ok(writing.includes(head), head);
  }
  // 从图到条目的对应：五种图都说到了，功能用例的八个字段都有着落（字段名与任务定义里的相同）。
  const mapping = writing.slice(writing.indexOf("1. **照图写条目。**"), writing.indexOf("2. **每条功能用例的来源写两张图。**"));
  for (const kind of ["用例图", "流程图", "状态图", "对象关系图", "系统边界图"]) assert.ok(mapping.includes(kind), kind);
  const definition = JSON.parse(readFileSync(join(ROOT, "task-types", "requirements-engineering", "docs", "task-definitions", "requirements-engineering.json"), "utf-8"));
  const useCase = definition.交付物.条目集合.find((one: { 名称: string }) => one.名称 === "功能用例");
  assert.equal(useCase.字段.length, 8);
  for (const field of useCase.字段 as { 名: string }[]) assert.ok(mapping.includes(`「${field.名}」`), field.名);
  assert.ok(writing.includes("种类写「图」，出处写图的编号（例如 D-002）"));
  assert.ok(writing.includes("任务里只有一张用例图，各条用例都指向它，不要为每条用例另画一张。"));
  assert.ok(writing.includes("这件事不牵涉状态图时，不必为了对应而补写。"));
});

test("编写文档那一段：补导语与概括句并写明依据；出口是请用户过目的卡片，不引出运行所以话要一次说完；分四种处理用户的话", () => {
  const text = read("document.md");
  const all = sections(text);
  const steps = [...all.get("这一段做什么")!.matchAll(/^(\d)\. \*\*([^*]+)\*\*/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(steps, ["1 通读。", "2 每章补一页导语。", "3 各节开头补一句概括。", "4 核对术语与说法。", "5 补写的每一处都写明依据。", "6 汇报。"]);
  for (const words of ["「导语所属章」填这一章的章名", "一章只立一页", "任务定义里没有「导语所属章」这个字段时不立导语页", "来源种类写「助手补充」",
    "不要自己挑一个改掉，记一条问题条目"]) assert.ok(all.get("这一段做什么")!.includes(words), words);
  // 七章的章名在任务类型的活动补充里，与程序里的相同；平台模板只说见任务类型说明。
  assert.ok(all.get("这一段做什么")!.includes("有哪几章、各章收哪些页，见任务类型说明"));
  const typeDocument = readFileSync(join(SRS_SKILL_DIR, "activities", "document.md"), "utf-8");
  for (const chapter of CHAPTERS) assert.ok(typeDocument.includes(chapter.name), chapter.name);
  assert.ok(!all.get("这一段做什么")!.includes("业务规则、业务目标"), "平台模板不列七章");
  const enough = all.get("做到什么算够")!;
  assert.ok(enough.startsWith("## 做到什么算够\n\n三件："));
  assert.equal(enough.slice(enough.indexOf("三件：")).split("。")[0].split("；").length, 3);
  assert.equal(stageLamps(EMPTY_LAMP_INPUT).document.length, 3);
  const exit = all.get(ENDING)!;
  assert.ok(exit.includes("`document_reviewed`「看过了，生成文档」、`document_revise`「需要修改」"));
  assert.ok(exit.includes("你不会因此再运行一次，所以要说的话在这张卡片上一次说完"));
  assert.ok(exit.includes("不要自己退回，提议回到前面的一步并写明原因"));
  assert.doesNotMatch(text, /`stage`「/, "这一段不教助手在回复里写 stage");
  assert.ok(exit.includes("直接改相应的主题页并写上来源，不用退回") && exit.includes("再提议回到那一步"));
});
