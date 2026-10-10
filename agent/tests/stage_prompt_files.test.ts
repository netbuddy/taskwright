/**
 * 有阶段的任务用的说明文件（agent/prompts/stages/）的内容检查。只读这些文件，不改。
 *
 * 平台说明现在有两份：早先的任务经 --skill 读的那一份（agent/prompts/skills/taskwright-executor/SKILL.md），
 * 与有阶段的任务放进系统提示的共用部分（agent/prompts/stages/common.md）。两份的第一到九节与第十一节本应相同，
 * 这里逐段核对：把早先那一份套上下面 EDITS 表里列的几处有意的改动之后，要与共用部分一字不差。
 * 改了其中一份而没有改另一份，这例测试会指出第一处不同的段落；确是只该改一份的，在 EDITS 里加一条并写明原因。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderDocument } from "../../scripts/render-intent-schema.mjs";

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
    to: "1. **什么时候画。** 核读材料与澄清两个阶段不能画图，工具会拒绝。从整理建模阶段起，用户说「把这几个用例画成用例图」「给退款流程画一张时序图」这类话时画；你觉得一张图能帮用户看清时先提议，用户同意之后再画，不要不问就画。",
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

test("共用部分的第十节只写各阶段都要用的：五个阶段与怎样移动、两张卡片的写法、主题页的四件事", () => {
  const ten = [...sections(read("common.md"))].find(([title]) => title.startsWith(SECTION_TEN))![1];
  for (const name of ["核读材料", "澄清", "整理建模", "写条目", "评审确认"]) assert.ok(ten.includes(name), name);
  for (const word of ["`stage`", "`reason`", "`start_items`「开始写条目」", "`continue_clarify`「继续澄清」", "`story_ok`", "`story_fix`", "`story_again`"]) assert.ok(ten.includes(word), word);
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
