/**
 * 执行者读的几份文件的内容检查：平台说明（代码仓里，所有任务类型共用）、各任务类型的任务 skill（只写这类任务的做法）、
 * 执行者的系统提示，以及启动配置里的工具清单。只读这些文件，不改。
 * 核对的是：平台说明只写通用的做法（修订号、被拒后的改法、评审由用户发起、同批引用）；
 * 任务 skill 里不出现平台层的写法（防止通用规则流回任务 skill）；两层都不提已经退役的工具与角色；启动配置的系统提示是哪一份。
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DIAGRAM_KINDS, DIAGRAM_KIND_NAMES } from "../src/lib/diagram.ts";
import { moduleText, platformText } from "./platform_text.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 平台说明：能力模块接起来的整份，所有任务类型共用。 */
const PLATFORM_TEXT = platformText();
const TASK_SKILLS = readdirSync(join(ROOT, "task-types"), { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((type) => {
  const base = join(ROOT, "task-types", type.name, ".pi", "skills");
  if (!existsSync(base)) return [];
  return readdirSync(base).map((name) => join(base, name, "SKILL.md")).filter((path) => existsSync(path));
}).sort();
const DEV_PROFILE = JSON.parse(readFileSync(join(ROOT, "backend", "profiles", "dev.json"), "utf-8"));

/** 平台层的词：工具名与回复工具、来源、版本号的参数名。它们只该出现在平台说明里。 */
const PLATFORM_WORDS = ["reply", "base_version", "base_revision", "version_no", "revision_no", "supports", "publish_version", "informs", "act"];
/** 已经退役的工具与角色：平台说明与任务 skill 里都不该再出现。登记用户确认工具与确认判读者在「已读即确认」时退役。 */
const RETIRED_WORDS = ["record_confirmation", "登记用户确认", "判读者"];

/** 拆出 SKILL.md 开头两行 --- 之间的「名字: 值」与其后的正文。没有 frontmatter 时返回空对象与全文。 */
function frontmatter(text: string): [Record<string, string>, string] {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) return [{}, text];
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at >= 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return [fields, match[2]];
}
const bodyOf = (path: string) => frontmatter(readFileSync(path, "utf-8"))[1];
const shown = (path: string) => relative(ROOT, path);
/** 一份任务 skill 的全部文字：SKILL.md 的正文，加上它旁边 activities/ 目录里各项活动的补充（去掉声明；有的任务类型没有这个目录）。 */
function taskSkillText(path: string): string {
  const activities = join(dirname(path), "activities");
  const parts = existsSync(activities) ? readdirSync(activities).sort().map((name) => bodyOf(join(activities, name))) : [];
  return [bodyOf(path), ...parts].join("\n");
}

test("平台说明只用修订号，不用版本号", () => {
  const body = PLATFORM_TEXT;
  for (const word of ["version_no", "base_version", "版本号是", "新版本", "当前版本"]) assert.ok(!body.includes(word), word);
  assert.doesNotMatch(body, /第 ?[0-9N一二三四五六七八九十]+ ?版/);
  assert.ok(body.includes("base_revision"));
  assert.ok(body.includes("revision_no"));
});

test("平台说明不写需求规格任务的专名", () => {
  const body = PLATFORM_TEXT;
  // 需求规格任务的问题集合现在叫「问题」，这是个日常词，平台说明也用它说问题条目，所以只拦旧名。
  for (const word of ["功能用例", "非功能需求", "待定与范围外事项", "UC-", "NFR-", "CON-", "TBD-", "requirements-engineering",
    "use-case-writing", "ears-writing", "基本流程", "前置条件"]) assert.ok(!body.includes(word), word);
});

test("平台说明「来源怎样填」写明来源的五种：助手补充要写理由、不用填出处、补进的字写在 inserted 里；依据另一个条目时种类写「条目」、依据一张图时种类写「图」，它改了之后会标「依据已变」", () => {
  const body = PLATFORM_TEXT;
  const section = moduleText("sources");
  for (const words of ["种类有五种：", "- **文档原文**：", "- **用户的话**：", "- **助手补充**：", "- **条目**：", "- **图**：",
    "出处写图的编号（例如 D-002）；摘录可以写空文字，也可以逐字抄图里一个节点上的文字", "图之后又改了，界面上这条来源旁同样会标「依据已变」",
    "出处不用填；摘录写一句理由：你为什么这样补、依据的是什么常识或推断，不写理由会被拒绝",
    "理由是随意写的话，里面怎样用引号都可以", "并用 `inserted` 逐字列出你补进那一处的字，一个字都不改", "页面靠 `inserted` 在正文里标出哪里是你补的",
    "助手补充的来源至少要有一处写 `inserted`，写的字不在那一处的正文里时保存会被拒绝",
    "这个条目依据了任务里的另一个条目", "出处写那个条目的编号（例如 OA-002），摘录逐字抄它当前内容里的一句；它必须还在",
    "系统会记下你引用时它是第几次修订：它之后又改了，界面上这条来源旁会标「依据已变」",
    "这时用 get_item 看它改了什么，需要的话更新这个条目并重新写这条来源"]) assert.ok(section.includes(words), words);
  // 早期版本的两个种类名、不再写入也不再显示的「用户直接修改」不留在说明里；来源一节不说「执行者」。
  for (const words of ["执行者补充", "种类写「领域说明」", "用户直接修改"]) assert.ok(!section.includes(words), words);
  assert.ok(!section.includes("执行者"));
});

test("平台说明有画图一节：核读材料与澄清两段不画、别的阶段用户要求时画或先提议、用保存图这一个工具、六种图的画法、节点写条目编号、来源怎样写、校验不过与改图删图", () => {
  const body = PLATFORM_TEXT;
  const section = moduleText("diagrams_full");
  assert.ok(section.startsWith("## 画图\n"));
  for (const words of ["核读材料与澄清两个阶段不能画图，工具会拒绝", "不要不问就画", "图不是条目，不要用 save_revision 存；图不评审，不算进完成条件",
    "用流程图的写法画，第一行写 `flowchart LR`", "参与者与用例都写成圆角节点，例如 `buyer([\"买家\"])`", "系统边界写成子图", "包含与扩展写在虚线上",
    "不要用 Mermaid 自带的用例图写法", "第一行写 `classDiagram`",
    "系统画成一个子图（`subgraph 系统名` 到 `end`）", "至少要有一个子图与一个子图之外的节点，否则保存会被拒绝",
    "类的名字只用英文字母与数字，条目编号与中文名写在方括号的文字里，例如 `class Loan[\"OA-003 借阅记录\"]`",
    "一张图是照哪个条目画出来的（例如某一页流程的流程图、某一页概念的状态图），那个条目也要写一条种类为「条目」的来源", "种类不能写「图」", "第一行写 `stateDiagram-v2`", "第一行写 `sequenceDiagram`", "第一行写 `flowchart TD`",
    "把条目编号写在这个节点的文字里，放在最前面", "不要把条目编号当节点的名字", "只写任务里现有的条目编号",
    "每个条目写一条种类为「条目」的来源，出处写条目编号，画图时这种来源不用写摘录", "图的来源不写 `supports`",
    "同一轮里连续三次没有通过，就不要再试：用回复告诉用户这张图哪里画不出来", "系统说这一次没有办法校验（不是文本写错了）时，图没有存，直接告诉用户",
    "写上图的编号（diagram）与你看到的它的修订号（base_revision）", "删图写 `delete` 为真", "用 get_item 写图的编号", "图的修订号是图自己的"]) {
    assert.ok(section.includes(words), words);
  }
  // 六个种类的写法与工具认的相同，叫法与种类的中文名表相同。
  for (const kind of DIAGRAM_KINDS) assert.ok(section.includes(`${DIAGRAM_KIND_NAMES[kind]}（${kind}）`), kind);
  assert.equal(DIAGRAM_KINDS.length, 6);
});

test("平台说明写明被拒之后不删信息换取通过", () => {
  const body = PLATFORM_TEXT;
  assert.ok(body.includes("不得为了通过而删掉引用、来源或关联条目"));
  assert.ok(body.includes("删掉信息换取通过是错误做法"));
});

test("平台说明有评审一节：评审由用户发起，请求评审的工具只在用户要求时用", () => {
  const body = PLATFORM_TEXT;
  assert.ok(moduleText("review").startsWith("## 评审\n"));
  for (const words of ["评审由用户在界面上发起，你不要主动评审", "用户在对话里要求评审时，才调用请求评审（request_review）",
    "问题类发现照建议改", "建议类发现告诉用户，由用户定", "不得为通过评审删掉内容或来源"]) assert.ok(body.includes(words), words);
});

test("平台说明写明 PDF 材料怎样读、出处怎样写：读投影、每块一行、表格按行不分格、摘录不跨页、没有文字的页那一行的意思、分段清单按页", () => {
  const body = PLATFORM_TEXT;
  for (const words of ["每份 PDF 材料有几页、几块、哪几页没有文字", "PDF 材料只读它的文字版，就是它旁边同名加 .md 的文件（例如 inputs/x.pdf.md），不要 read .pdf 本身",
    "文字版每块一行，行首方括号里是页与块，例如 `[p3-2]` 是第 3 页的第 2 块", "以 `>` 开头的行是页眉页脚，没有页与块，不能作出处",
    "表格按行读，不分格：表格的一行是一块", "写着「（这一页没有文字，可能是扫描件）」的那一行块号是 0，意思是这一页读不出字，它不能作出处",
    "分段清单（同名加 .segments.json）按页分段", "引用时出处写 PDF 文件加页与块，例如 `inputs/x.pdf#p3-2`",
    "摘录不要跨页：一句话跨了两页，就分成两条来源，各写各的页与块", "PDF 文档照材料的办法加页与块（例如 `knowledge/lib-0a1b2c3d/借阅规范.pdf#p3-2`",
    "PDF 材料每条各写页与块（写法见「先看材料」）"]) assert.ok(body.includes(words), words);
  // 说明里的那句「没有文字」要与投影里写的一字不差（backend/src/pdf_projection.ts 的 NO_TEXT_LINE）。
  assert.ok(body.includes("（这一页没有文字，可能是扫描件）"));
});

test("平台说明写明知识库什么时候必须查、怎样查（用查找知识库这一个办法，两路并行）、查到的片段怎样照抄、来源怎样记", () => {
  const body = PLATFORM_TEXT;
  // 什么时候必须查：材料把具体内容指给别的文档时，不以用户提没提知识库为条件。
  for (const words of ["必须到知识库里把那条具体规定查出来，把规定本身写进条目", "这一条不看用户有没有提到知识库", "保存之前对照材料数一遍"]) assert.ok(body.includes(words), words);
  // 查不到时分两种：公开的常识或法规写进条目并用「助手补充」来源写明理由；别的保留材料原话、记问题条目，不编。
  for (const words of ["先看它是不是公开的常识或法规（例如七天无理由退货）", "来源种类写「助手补充」并写明理由（写法见「来源怎样填」）",
    "另外新增一条问题条目写明「材料指向某某规定，知识库里没有找到」", "不要自己编一个规定填上"]) assert.ok(body.includes(words), words);
  // 「助手补充」是保存修订认的种类名；早期版本的叫法「执行者补充」不能留在说明里。
  assert.ok(!body.includes("执行者补充"));
  // 清单里不写路径，文档不分大小都经查找；查知识库用这一个办法，不要用 grep 去翻；两路并行；不用写 limit。
  for (const words of ["不写读它用的路径：知识库文档不分大小，一律用 search_knowledge 查", "查知识库用 search_knowledge 这一个办法；不要用 grep 去翻知识库，命中太多也拿不全",
    "它同时按意思与按字面两路找", "一次查一件事，要查几件就分几次查", "不要只写一个词", "知道条号或原话时把条号、原话写进去", "不用写 `limit`",
    "grep 与 find 只在任务目录里用；一次返回最多 40 行，命中太多时换更具体的词，或者分次搜。"]) assert.ok(body.includes(words), words);
  // 查到之后：片段就是逐字的原文，照抄，不必再读文件核对；一个片段里有多条规定时逐条看；Word 与表格的抄法；没列出的缩小再查；只按字面时照样可用。
  for (const words of ["正文夹在「<<<原文开始」与「原文结束>>>」之间", "排在第一的也可能不是你要的规定", "一个片段里有多条规定时逐条看，材料的说法与规范的用词常不同",
    "查到的片段就是逐字的原文：摘录从片段里逐字抄，连空行一起原样抄，不要把不相邻的两条接起来", "摘录不带它，出处写摘录所在那一段的段落号", "表格里一条来源只抄一格里的字",
    "不必再读知识库文件核对：保存时系统会逐字核对，对不上会退回并说明原因", "结果说还有几条没有列出时，把问题缩小再查",
    "没有找到时换一种说法再查一次；换了说法仍然没有，才算知识库里没有", "它说这一次只按字面找了（没有选嵌入模型，或者文档还没有向量化好）时，结果照样可以用",
    "表格里的字，段落号写摘录所在那一格里那一段的"]) assert.ok(body.includes(words), words);
  // 已经撤掉或没有做的说法不能留：路径拦截、读原文核对、小文档整份读、相邻片段、最多几个。
  for (const words of ["也不能用 ls 看", "会被系统拦下", "读原文核对", "按字面查找（grep）", "可以用 read 整份读", "清单给的绝对路径", "读清单里给的投影", "相邻片段", "相邻的前一个", "最多 5"]) {
    assert.ok(!body.includes(words), words);
  }
  // 来源怎样记：摘录从条号开始抄；每条知识库来源都写明支持哪一处，「来源怎样填」同样要求。
  for (const words of ["文档里的规定带条号时，摘录从条号开始抄", "每条知识库来源都必须用 `supports` 写明它支持条目的哪个字段、哪一项",
    "条目有两条或更多来源时，每条来源都必须写 `supports`；出处指向知识库的来源一律必须写"]) assert.ok(body.includes(words), words);
  // 说明里一律说「知识库」，不简称「库」；「任务库」是另一样东西。
  assert.doesNotMatch(body.replaceAll("知识库", "").replaceAll("任务库", ""), /这个库|那个库|库里|选用的库/);
});

// 工具数量受限是产品的原则：新增一个工具之前，先排除用现有工具的参数、读会话记录、改后端或页面代码这几条路能不能做到。
// 这一例盯着启动配置里的工具清单；增减工具时要有意识地改这里的个数与名单，不要顺手改掉。
test("执行者的工具清单是十二个：含请求评审、查找知识库、保存图与自带的检索工具 grep、find；扩展里登记了请求评审、查找知识库与保存图", () => {
  const tools: string[] = DEV_PROFILE.tools;
  assert.equal(tools.length, 12, JSON.stringify(tools));
  assert.ok(tools.includes("request_review") && tools.includes("search_knowledge") && tools.includes("save_diagram"));
  assert.ok(tools.includes("grep") && tools.includes("find"), JSON.stringify(tools));
  const extension = readFileSync(join(ROOT, "agent", "src", "extension.ts"), "utf-8");
  assert.ok(extension.includes("registerRequestReview(pi);") && extension.includes("registerSearchKnowledge(pi);"));
  // 整行核对：登记保存图的那一行被注释掉也要抓得到。
  assert.match(extension, /^  registerSaveDiagram\(pi\);$/m);
  // 三个启动配置的工具清单相同。
  for (const name of ["desktop", "fake"]) {
    assert.deepEqual(JSON.parse(readFileSync(join(ROOT, "backend", "profiles", `${name}.json`), "utf-8")).tools, tools, name);
  }
  assert.ok(!("开发期开关" in DEV_PROFILE), "评审门禁做出来之后开发期开关退役");
});

test("同批引用：平台说明写明可以引用同一批里排在前面的新增条目；任务 skill 仍把问题条目放在最后一批", () => {
  const platform = PLATFORM_TEXT;
  assert.ok(platform.includes("问题条目的关联条目只能填已经存在的条目，或者同一批里排在它前面新增的条目"));
  assert.ok(platform.includes("也可以写同一批里排在前面的新增操作将要拿到的编号"));
  // 保存修订已经认同一批里排在前面的新增条目，这句旧说法与工具行为相反，不能再出现。
  for (const [name, text] of [["平台说明", PLATFORM_TEXT], ...TASK_SKILLS.map((path) => [shown(path), bodyOf(path)])]) assert.ok(!text.includes("同一批里新增的条目还没有编号"), name);
  for (const path of TASK_SKILLS) {
    assert.ok(taskSkillText(path).includes("再把问题条目单独放在最后一批保存，不和别的条目放在同一批：每批内容少，出错时好改。"), shown(path));
  }
});

test("至少有一份任务 skill", () => {
  assert.ok(TASK_SKILLS.length > 0);
});

test("任务 skill 的正文不含平台层的词", () => {
  assert.ok(TASK_SKILLS.length > 0);
  for (const path of TASK_SKILLS) {
    const body = taskSkillText(path);
    for (const word of PLATFORM_WORDS) {
      // 前后都不是英文字母或下划线才算这个词，免得 act 误中 action、contract 之类。
      assert.doesNotMatch(body, new RegExp(`(?<![A-Za-z_])${word}(?![A-Za-z_])`), `${shown(path)} 里出现了平台层的词 ${word}`);
    }
  }
});

test("两层 skill 都不提已经退役的工具与角色", () => {
  for (const [name, text] of [["平台说明", PLATFORM_TEXT], ...TASK_SKILLS.map((path) => [shown(path), readFileSync(path, "utf-8")])]) {
    for (const word of RETIRED_WORDS) assert.ok(!text.includes(word), `${name} 里还提到已退役的 ${word}`);
  }
});

test("任务 skill 指向平台说明，不再提早先的平台说明", () => {
  assert.ok(TASK_SKILLS.length > 0);
  for (const path of TASK_SKILLS) {
    const text = readFileSync(path, "utf-8");
    assert.ok(text.includes("平台说明"), shown(path));
    assert.ok(!text.includes("taskwright-executor"), shown(path));
  }
});

test("需求规格任务的 skill 用新的集合名「问题」", () => {
  const body = readFileSync(join(ROOT, "task-types", "requirements-engineering", ".pi", "skills", "requirements-engineering", "SKILL.md"), "utf-8");
  assert.ok(!body.includes("待定与范围外事项"));
  assert.ok(!body.includes("待定事项"));
  assert.ok(body.includes("「问题」集合里的条目叫问题条目，编号前缀是 TBD"));
});

test("启动配置的系统提示就是有阶段的任务用的那一份，且不提领域", () => {
  assert.equal(DEV_PROFILE.system_prompt_file, "agent/prompts/system.md");
  const text = readFileSync(join(ROOT, DEV_PROFILE.system_prompt_file), "utf-8");
  assert.ok(text.startsWith("你是 Taskwright 的执行者"));
  assert.ok(!text.includes("需求工程"));
});

test("系统提示一律说「知识库」，不简称「库」，不用写给开发者看的词；知识库的规矩写在平台说明「知识库怎样用」", () => {
  const text = readFileSync(join(ROOT, DEV_PROFILE.system_prompt_file), "utf-8");
  assert.doesNotMatch(text.replaceAll("知识库", ""), /库/);
  for (const word of ["检索", "向量", "进程", "项目", "不能用 grep", "也不能用 ls", "读原文核对"]) assert.ok(!text.includes(word), word);
  assert.ok(moduleText("knowledge").startsWith("## 知识库怎样用\n"));
});
