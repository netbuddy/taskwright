/**
 * 图表的校验（src/diagram_validate.ts）：五种图合法的通过、写错的报出第几行；种类不符、开头认不出、空文本、超长各有各的说法；
 * 到时限没有算完就结束那条线程，下一次照常能校验；校验引擎加载不了时说明是程序这边的问题，不说成文本写错。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { DIAGRAM_KINDS, DIAGRAM_TEXT_LIMIT, DiagramChecker, type DiagramCheck, type DiagramKind, diagramEngineUrl, validateDiagram } from "../src/diagram_validate.ts";
import { ROOT } from "./helpers.ts";

const checker = new DiagramChecker();
after(() => checker.stop());

/** 每种图一份合法的文本；用例图用流程图的写法画。 */
const GOOD: Record<DiagramKind, string> = {
  use_case: [
    "flowchart LR",
    '  buyer(["买家"])',
    '  subgraph sys["售后系统"]',
    '    UC001(["UC-001 提交售后申请"])',
    '    UC002(["UC-002 审核售后申请"])',
    "  end",
    "  buyer --- UC001",
    "  UC002 -. 包含 .-> UC001",
  ].join("\n"),
  class: [
    "classDiagram",
    '  class AfterSale["售后单"] {',
    "    +String 售后单号",
    "    +提交()",
    "  }",
    '  class Refund["退款单"]',
    '  AfterSale "1" --> "0..1" Refund : 产生',
  ].join("\n"),
  state: ["stateDiagram-v2", "  [*] --> 待审核 : 买家提交", "  待审核 --> 待退款 : 审核通过", "  待退款 --> [*]"].join("\n"),
  sequence: ["sequenceDiagram", "  actor 买家", "  participant 系统 as 售后系统", "  买家->>系统: 提交售后申请", "  系统-->>买家: 通知审核结果"].join("\n"),
  flowchart: ["flowchart TD", "  A([买家提交售后申请]) --> B{是否可退}", "  B -- 是 --> C[售后专员审核]", "  B -- 否 --> D[系统拦下并告知原因]"].join("\n"),
};

/** 每种图一份故意写错的文本，与写错的那一行（解析时的原话里写的行号可能是下一行）。 */
const BAD: Record<DiagramKind, { text: string; line: number }> = {
  // 第 3 行的子图没有 end：要读到文本结束才发现，所以指的是最后一行。
  use_case: { text: ["flowchart LR", '  buyer(["买家"])', '  subgraph sys["售后系统"]', '    UC001(["UC-001 提交售后申请"])', "  buyer --- UC001"].join("\n"), line: 5 },
  // 第 2 行的类没有闭合花括号，第 4 行又开了一个。
  class: { text: ["classDiagram", '  class AfterSale["售后单"] {', "    +String 售后单号", '  class Refund["退款单"] {', "    +Decimal 金额", "  }"].join("\n"), line: 4 },
  // 第 3 行的箭头少了一道横线。
  state: { text: ["stateDiagram-v2", "  [*] --> 待审核 : 买家提交", "  待审核 -> 待退款 : 审核通过"].join("\n"), line: 3 },
  // 第 3 行的消息前面少了冒号。
  sequence: { text: ["sequenceDiagram", "  actor 买家", "  买家->>系统 提交售后申请", "  系统-->>买家: 通知"].join("\n"), line: 3 },
  // 第 2 行的方括号没有闭合。
  flowchart: { text: ["flowchart TD", "  A[买家提交售后申请 --> B[审核]", "  B --> C[退款]"].join("\n"), line: 2 },
};

const failed = (check: DiagramCheck) => {
  assert.equal(check.ok, false);
  return check as Extract<DiagramCheck, { ok: false }>;
};

/** 一份接近上限的合法类图：解析它要一秒上下，用来试时限。 */
function bigClassDiagram(): string {
  let text = "classDiagram\n";
  for (let n = 1; Buffer.byteLength(text) < DIAGRAM_TEXT_LIMIT - 200; n++) text += `  class C${n}["售后单 ${n}"] {\n    +String 售后单号\n    +提交()\n  }\n`;
  return text;
}

test("五种图合法的文本都通过", async () => {
  for (const kind of DIAGRAM_KINDS) assert.deepEqual(await checker.validate(kind, GOOD[kind]), { ok: true }, kind);
});

test("五种图写错的文本都报语法不对，说出第几行，并带着解析时的原话", async () => {
  for (const kind of DIAGRAM_KINDS) {
    const check = failed(await checker.validate(kind, BAD[kind].text));
    assert.equal(check.reason, "syntax", kind);
    assert.equal(check.line, BAD[kind].line, `${kind}：${check.message}`);
    assert.match(check.message, new RegExp(`^Mermaid 文本第 ${BAD[kind].line} (到 \\d+ )?行附近写得不对，改了再存。(文本到这里就结束了[^。]*。)?解析时的原话：`), kind);
    assert.match(check.message, /Expecting|expecting/, kind);
  }
  // 少了收尾的 end：另加一句说明。
  assert.match(failed(await checker.validate("use_case", BAD.use_case.text)).message,
    /^Mermaid 文本第 5 行附近写得不对，改了再存。文本到这里就结束了，多半是前面有括号没有闭合，或者子图、分支少了收尾的 end。解析时的原话：/);
});

test("括号没有闭合时，开头那一行与发现不对的那一行都写出来", async () => {
  const check = failed(await checker.validate("flowchart", ["flowchart TD", "  A[开始] --> B[没有闭合", "  B --> C[结束]"].join("\n")));
  assert.equal(check.line, 2);
  assert.match(check.message, /^Mermaid 文本第 2 到 3 行附近写得不对/);
});

test("写的不是说好的那一种：说出写的是哪一种；用例图与流程图都认流程图的写法", async () => {
  const asClass = failed(await checker.validate("class", GOOD.sequence));
  assert.equal(asClass.reason, "kind_mismatch");
  assert.equal(asClass.message, "写的是时序图，不是你说的类图。");
  const asUseCase = failed(await checker.validate("use_case", GOOD.class));
  assert.equal(asUseCase.message, "写的是类图，不是你说的用例图。用例图用流程图的写法画，第一行写 flowchart。");
  const pie = failed(await checker.validate("flowchart", 'pie\n  "合格" : 3\n  "不合格" : 1'));
  assert.equal(pie.message, "写的是饼图，不是你说的流程图。");
  // 种类不符先于语法：一份写错的时序图当作状态图交来，说的是种类不符。
  assert.equal(failed(await checker.validate("state", BAD.sequence.text)).reason, "kind_mismatch");
  assert.deepEqual(await checker.validate("flowchart", GOOD.use_case), { ok: true });
  assert.deepEqual(await checker.validate("use_case", GOOD.flowchart), { ok: true });
  assert.deepEqual(await checker.validate("flowchart", "graph TD\n  A --> B"), { ok: true });
});

test("开头认不出是哪种图", async () => {
  const check = failed(await checker.validate("state", "买家提交售后申请之后，售后专员审核。"));
  assert.equal(check.reason, "unknown_type");
  assert.equal(check.message, "Mermaid 文本的开头没有写图的类型，或者写的不是用例图、类图、状态图、时序图、流程图里的一种。状态图的第一行要先写明类型。");
});

test("空文本、只有空白、不是文字，都说没有可以校验的内容；种类写得不对是调用方的错，直接报错", async () => {
  for (const text of ["", "  \n\t", undefined, 12]) assert.equal(failed(await checker.validate("flowchart", text)).reason, "empty");
  await assert.rejects(checker.validate("用例图", GOOD.use_case), /图的种类要写 use_case、class、state、sequence、flowchart 里的一个/);
});

test("超过上限的文本不校验，说出有多大；正好在上限以内的照常校验", async () => {
  const line = "  N1[售后专员审核] --> N2[财务发起退款]\n";
  let text = "flowchart TD\n";
  while (Buffer.byteLength(text + line) <= DIAGRAM_TEXT_LIMIT) text += line;
  assert.deepEqual(await checker.validate("flowchart", text), { ok: true });
  const check = failed(await checker.validate("flowchart", text + line));
  assert.equal(check.reason, "too_long");
  assert.match(check.message, /^Mermaid 文本有 20\.\d KB，超过了 20 KB 的上限。/);
});

test("同时交来的几份一份一份地校验，各得各的结果", async () => {
  const jobs = DIAGRAM_KINDS.flatMap((kind) => [checker.validate(kind, GOOD[kind]), checker.validate(kind, BAD[kind].text)]);
  const results = await Promise.all(jobs);
  assert.deepEqual(results.map((r) => (r.ok ? "ok" : r.reason)), DIAGRAM_KINDS.flatMap(() => ["ok", "syntax"]));
});

test("到时限还没有算完：说没有存，结束那条线程；下一次照常能校验", async () => {
  const hasty = new DiagramChecker();
  try {
    // 先照平常的时限校验一份小的，让引擎与类图的解析代码都加载好。
    assert.deepEqual(await hasty.validate("class", GOOD.class), { ok: true });
    const check = failed(await hasty.validate("class", bigClassDiagram(), 20));
    assert.equal(check.reason, "timeout");
    assert.equal(check.message, "这段 Mermaid 文本校验了 0.02 秒还没有算完，没有存。把图画得小一些再试。");
    assert.deepEqual(await hasty.validate("class", GOOD.class), { ok: true });
  } finally {
    await hasty.stop();
  }
});

test("校验引擎加载不了，或者里面没有要用的函数：说是程序这边的问题，不说成文本写错", async () => {
  for (const [engine, detail] of [
    ["file:///nowhere/diagram_engine.mjs", /校验引擎加载不了：/],
    ["data:text/javascript,export const other = 1;", /校验引擎加载不了：校验引擎里没有 inspect/],
  ] as const) {
    const broken = new DiagramChecker({ engine });
    try {
      const check = failed(await broken.validate("flowchart", GOOD.flowchart));
      assert.equal(check.reason, "unavailable");
      assert.match(check.message, detail);
      assert.match(check.message, /这是程序这边的问题，不是文本写错了，请告诉用户。$/);
      // 再来一次仍是同样的说法，不会卡住。
      assert.equal(failed(await broken.validate("flowchart", GOOD.flowchart)).reason, "unavailable");
    } finally {
      await broken.stop();
    }
  }
});

test("任务服务用的那一个校验器：不用另外准备就能校验", async () => {
  assert.deepEqual(await validateDiagram("sequence", GOOD.sequence), { ok: true });
  assert.equal(failed(await validateDiagram("sequence", BAD.sequence.text)).reason, "syntax");
});

test("仓库里校验引擎用源文件；安装包的构建脚本把校验模块、线程入口与打好的引擎都放进去", () => {
  // 仓库里没有 backend/vendor/（它只在安装包里），所以用的是 src/diagram_engine.mjs。
  assert.match(diagramEngineUrl(), /\/backend\/src\/diagram_engine\.mjs$/);
  const build = readFileSync(join(ROOT, "release", "build.mjs"), "utf-8");
  // 校验模块现在还没有别的文件导入它，线程入口是按文件名起的：两个都得列为构建脚本收文件的起点，否则不进安装包。
  for (const entry of ["backend/src/diagram_validate.ts", "backend/src/diagram_worker.ts"]) assert.ok(build.includes(`"${entry}"`), `release/build.mjs 的起点里没有 ${entry}`);
  // 打好的引擎放的位置要与 diagramEngineUrl 找的位置相同。
  assert.ok(build.includes('path.join(payload, "backend", "vendor", "mermaid")'), "release/build.mjs 没有把打好的引擎放到 backend/vendor/mermaid/");
  assert.match(readFileSync(join(ROOT, "backend", "src", "diagram_validate.ts"), "utf-8"), /fromRoot\("backend\/vendor\/mermaid\/diagram_engine\.mjs"\)/);
});

test("仓库里校验用的 mermaid 就是页面清单里写明的那个版本", () => {
  // 后端不另装 mermaid，用的是仓根安装的那一份；页面画图用的也是它。两边版本相同，「校验通过」与「页面画得出」才对得上。
  const declared = JSON.parse(readFileSync(join(ROOT, "web", "package.json"), "utf-8")).dependencies.mermaid;
  const installed = JSON.parse(readFileSync(join(ROOT, "node_modules", "mermaid", "package.json"), "utf-8")).version;
  assert.match(declared, /^\d+\.\d+\.\d+$/, "web/package.json 里 mermaid 的版本要钉死，不带 ^ 或 ~");
  assert.equal(installed, declared);
});
