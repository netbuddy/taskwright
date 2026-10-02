/**
 * 执行者读的几份文件的内容检查：平台 skill（代码仓里，所有任务类型共用）、各任务类型的任务 skill（只写这类任务的做法）、
 * 执行者的系统提示，以及启动配置里的工具清单。只读这些文件，不改。
 * 核对的是：平台 skill 合不合 pi 的要求；平台 skill 只写通用的做法（修订号、被拒后的改法、评审由用户发起、同批引用）；
 * 任务 skill 里不出现平台层的写法（防止通用规则流回任务 skill）；两层都不提已经退役的工具与角色；系统提示先读平台 skill。
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLATFORM_DIR = join(ROOT, "agent", "prompts", "skills", "taskwright-executor");
const PLATFORM = join(PLATFORM_DIR, "SKILL.md");
const TASK_SKILLS = readdirSync(join(ROOT, "task-types"), { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((type) => {
  const base = join(ROOT, "task-types", type.name, ".pi", "skills");
  if (!existsSync(base)) return [];
  return readdirSync(base).map((name) => join(base, name, "SKILL.md")).filter((path) => existsSync(path));
}).sort();
const DEV_PROFILE = JSON.parse(readFileSync(join(ROOT, "backend", "profiles", "dev.json"), "utf-8"));

/** 平台层的词：工具名与回复工具、来源、版本号的参数名。它们只该出现在平台 skill 里。 */
const PLATFORM_WORDS = ["reply", "base_version", "base_revision", "version_no", "revision_no", "supports", "complete_task", "informs", "act"];
/** 已经退役的工具与角色：平台 skill 与任务 skill 里都不该再出现。登记用户确认工具与确认判读者在「已读即确认」时退役。 */
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

test("平台 skill 的文件存在，frontmatter 合 pi 的要求：name 与目录同名、只用小写字母数字与连字符、不超过 64 个字符；description 必填", () => {
  const [fields, body] = frontmatter(readFileSync(PLATFORM, "utf-8"));
  assert.equal(fields.name, "taskwright-executor");
  assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(fields.name.length <= 64);
  assert.ok(fields.description);
  assert.ok(body.trim());
});

test("平台 skill 只用修订号，不用版本号", () => {
  const body = bodyOf(PLATFORM);
  for (const word of ["version_no", "base_version", "版本号是", "新版本", "当前版本"]) assert.ok(!body.includes(word), word);
  assert.doesNotMatch(body, /第 ?[0-9N一二三四五六七八九十]+ ?版/);
  assert.ok(body.includes("base_revision"));
  assert.ok(body.includes("revision_no"));
});

test("平台 skill 不写需求规格任务的专名", () => {
  const body = bodyOf(PLATFORM);
  // 需求规格任务的问题集合现在叫「问题」，这是个日常词，平台 skill 也用它说问题条目，所以只拦旧名。
  for (const word of ["功能用例", "非功能需求", "待定与范围外事项", "UC-", "NFR-", "CON-", "TBD-", "srs-authoring",
    "use-case-writing", "ears-writing", "基本流程", "前置条件"]) assert.ok(!body.includes(word), word);
});

test("平台 skill 写明被拒之后不删信息换取通过", () => {
  const body = bodyOf(PLATFORM);
  assert.ok(body.includes("不得为了通过而删掉引用、来源或关联条目"));
  assert.ok(body.includes("删掉信息换取通过是错误做法"));
});

test("平台 skill 有评审一节：评审由用户发起，请求评审的工具只在用户要求时用", () => {
  const body = bodyOf(PLATFORM);
  assert.ok(body.includes("## 六、评审"));
  for (const words of ["评审由用户在界面上发起，你不要主动评审", "用户在对话里要求评审时，才调用请求评审（request_review）",
    "问题类发现照建议改", "建议类发现告诉用户，由用户定", "不得为通过评审删掉内容或来源"]) assert.ok(body.includes(words), words);
});

test("平台 skill 写明知识库什么时候必须查、怎样查、来源怎样记", () => {
  const body = bodyOf(PLATFORM);
  // 什么时候必须查：材料把具体内容指给别的文档时，不以用户提没提知识库为条件；查不到就记问题条目，不编。
  for (const words of ["必须到知识库里把那条具体规定查出来，把规定本身写进条目", "这一条不看用户有没有提到知识库",
    "保存之前对照材料数一遍", "另外新增一条问题条目", "不要自己编一个规定填上"]) assert.ok(body.includes(words), words);
  // 怎样查：小文档可以整份读，大文档先按字面找再按行读；要找的词不许是什么都能匹配的写法。
  for (const words of ["不超过 4 KB 的文档可以用 read 整份读", "超过 4 KB 的不要整份读", "一次不超过 120 行",
    "不得写 `.*`、`.`、空串这类什么都能匹配的写法", "一个词没有找到时换近义词再找"]) assert.ok(body.includes(words), words);
  // 来源怎样记：摘录从条号开始抄；每条知识库来源都写明支持哪一处，第四节同样要求。
  for (const words of ["文档里的规定带条号时，摘录从条号开始抄", "每条知识库来源都必须用 `supports` 写明它支持条目的哪个字段、哪一项",
    "条目有两条或更多来源时，每条来源都必须写 `supports`；出处指向知识库的来源一律必须写"]) assert.ok(body.includes(words), words);
  // 说明里一律说「知识库」，不简称「库」；「任务库」是另一样东西。
  assert.doesNotMatch(body.replaceAll("知识库", "").replaceAll("任务库", ""), /这个库|那个库|库里|选用的库/);
});

// 工具数量受限是产品的原则：新增一个工具之前，先排除用现有工具的参数、读会话记录、改后端或页面代码这几条路能不能做到。
// 这一例盯着启动配置里的工具清单；增减工具时要有意识地改这里的个数与名单，不要顺手改掉。
test("执行者的工具清单是十个：含请求评审与自带的检索工具 grep、find；扩展里登记了请求评审", () => {
  const tools: string[] = DEV_PROFILE.tools;
  assert.equal(tools.length, 10, JSON.stringify(tools));
  assert.ok(tools.includes("request_review"));
  assert.ok(tools.includes("grep") && tools.includes("find"), JSON.stringify(tools));
  assert.ok(readFileSync(join(ROOT, "agent", "src", "extension.ts"), "utf-8").includes("registerRequestReview(pi);"));
  assert.ok(!("开发期开关" in DEV_PROFILE), "评审门禁做出来之后开发期开关退役");
});

test("同批引用：平台 skill 写明可以引用同一批里排在前面的新增条目；任务 skill 仍把问题条目放在最后一批", () => {
  const platform = bodyOf(PLATFORM);
  assert.ok(platform.includes("问题条目的关联条目只能填已经存在的条目，或者同一批里排在它前面新增的条目"));
  assert.ok(platform.includes("也可以写同一批里排在前面的新增操作将要拿到的编号"));
  // 保存修订已经认同一批里排在前面的新增条目，这句旧说法与工具行为相反，不能再出现。
  for (const path of [PLATFORM, ...TASK_SKILLS]) assert.ok(!bodyOf(path).includes("同一批里新增的条目还没有编号"), shown(path));
  for (const path of TASK_SKILLS) {
    assert.ok(bodyOf(path).includes("再把问题条目单独放在最后一批保存，不和别的条目放在同一批：每批内容少，出错时好改。"), shown(path));
  }
});

test("至少有一份任务 skill", () => {
  assert.ok(TASK_SKILLS.length > 0);
});

test("任务 skill 的正文不含平台层的词", () => {
  assert.ok(TASK_SKILLS.length > 0);
  for (const path of TASK_SKILLS) {
    const body = bodyOf(path);
    for (const word of PLATFORM_WORDS) {
      // 前后都不是英文字母或下划线才算这个词，免得 act 误中 action、contract 之类。
      assert.doesNotMatch(body, new RegExp(`(?<![A-Za-z_])${word}(?![A-Za-z_])`), `${shown(path)} 里出现了平台层的词 ${word}`);
    }
  }
});

test("两层 skill 都不提已经退役的工具与角色", () => {
  for (const path of [PLATFORM, ...TASK_SKILLS]) {
    const text = readFileSync(path, "utf-8");
    for (const word of RETIRED_WORDS) assert.ok(!text.includes(word), `${shown(path)} 里还提到已退役的 ${word}`);
  }
});

test("任务 skill 指向平台 skill", () => {
  assert.ok(TASK_SKILLS.length > 0);
  for (const path of TASK_SKILLS) assert.ok(readFileSync(path, "utf-8").includes("taskwright-executor"), shown(path));
});

test("需求规格任务的 skill 用新的集合名「问题」", () => {
  const body = readFileSync(join(ROOT, "task-types", "srs-authoring", ".pi", "skills", "srs-authoring", "SKILL.md"), "utf-8");
  assert.ok(!body.includes("待定与范围外事项"));
  assert.ok(!body.includes("待定事项"));
  assert.ok(body.includes("「问题」集合里的条目叫问题条目，编号前缀是 TBD"));
});

test("系统提示先读平台 skill，且不提领域", () => {
  const text = readFileSync(join(ROOT, DEV_PROFILE.system_prompt_file), "utf-8");
  assert.ok(text.startsWith("你是 Taskwright 的执行者"));
  assert.ok(text.includes("先用 read 读 taskwright-executor 的正文，再读任务 skill 的正文"));
  assert.ok(!text.includes("需求工程"));
});
