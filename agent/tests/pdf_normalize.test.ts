// PDF 材料的文字规范化：整理（tidyPdfText）与比较（comparablePdfText）。
// 特殊字符一律用码位数字写出来，免得源文件里有看不出差别的字。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { comparablePdfText, tidyPdfText } from "../src/lib/pdf_normalize.ts";

const at = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

test("整理：康熙部首区的字符换成通用汉字", () => {
  // U+2F2F 工、U+2F47 日、U+2FA6 金、U+2F00 一、U+2FD5 龠（这一区的头与尾）
  assert.equal(tidyPdfText(`两个${at(0x2f2f)}作${at(0x2f47)}内退回${at(0x2fa6)}额`), "两个工作日内退回金额");
  assert.equal(tidyPdfText(at(0x2f00, 0x2fd5)), at(0x4e00, 0x9fa0));
});

test("整理：部首补充区的字符按对照表换成通用汉字", () => {
  // U+2EDB 风、U+2E85 亻、U+2ECF 邑、U+2EA1 氵；U+2E9F 母与 U+2EF3 龟是 NFKC 自己也能换的两个，结果相同
  assert.equal(tidyPdfText(`${at(0x2edb)}险`), "风险");
  assert.equal(tidyPdfText(at(0x2e85, 0x2ecf, 0x2ea1)), at(0x4ebb, 0x9091, 0x6c35));
  assert.equal(tidyPdfText(at(0x2e9f, 0x2ef3)), at(0x6bcd, 0x9f9f));
  // 对应的通用汉字在基本平面之外的（U+2E87 对 U+20628），以及排在它后面的（U+2E88 刀），都要换对
  assert.equal(tidyPdfText(at(0x2e87, 0x2e88)), at(0x20628, 0x5200));
  // U+2E80 在对照表里没有对应的字，原样留着
  assert.equal(tidyPdfText(at(0x2e80)), at(0x2e80));
});

test("整理：部首补充区对照表有 114 对，一边都在部首补充区，另一边都不在两个部首区", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "lib", "pdf_normalize.ts"), "utf-8");
  const pairs = /RADICAL_SUPPLEMENT_PAIRS = "([^"]+)"/.exec(source)![1].split(" ").map((pair) => Array.from(pair));
  assert.equal(pairs.length, 114);
  assert.equal(new Set(pairs.map(([radical]) => radical)).size, 114);
  for (const pair of pairs) {
    assert.equal(pair.length, 2, `一对应当是两个字符：${pair.join("")}`);
    const [radical, ideograph] = pair.map((c) => c.codePointAt(0)!);
    assert.ok(radical >= 0x2e81 && radical <= 0x2ef3, `U+${radical.toString(16)} 不在部首补充区`);
    assert.ok(ideograph < 0x2e80 || ideograph > 0x2fd5, `U+${ideograph.toString(16)} 还是部首字符`);
    assert.equal(tidyPdfText(at(radical)), at(ideograph));
  }
});

test("整理：去掉软连字符与零宽字符", () => {
  assert.equal(tidyPdfText(`办${at(0xad)}理${at(0x200b)}退${at(0x200c)}款${at(0x200d)}申${at(0xfeff)}请`), "办理退款申请");
});

test("整理：连续三个以上「中日韩字符加空格」的地方去掉空格，别处的空格不动", () => {
  assert.equal(tidyPdfText("涉及跨境订单 时 ， 汇 率 按 申 请 当 日 16:00 的 中 间 价"), "涉及跨境订单时，汇率按申请当日 16:00 的中间价");
  // 只有一处「字 空格 字」的不动：它可能是原文里本来就有的空格
  assert.equal(tidyPdfText("第1条 退款申请的规则"), "第1条 退款申请的规则");
  assert.equal(tidyPdfText("签收后 8 天内"), "签收后 8 天内");
  // 两个空格隔开的（表格一行里的几格）不动
  assert.equal(tidyPdfText("是  否  是  否"), "是  否  是  否");
  assert.equal(tidyPdfText("the audit log shall be immutable"), "the audit log shall be immutable");
});

test("整理：连字符、全角字符、连字都不动", () => {
  const text = `high-level learn- ing （USD/CNY），${at(0xfb01)}nal`;
  assert.equal(tidyPdfText(text), text);
});

test("比较：先做整理，部首字符与通用汉字比较起来相同", () => {
  assert.equal(comparablePdfText(`两个${at(0x2f2f)}作${at(0x2f47)}内，${at(0x2edb)}险`), comparablePdfText("两个工作日内，风险"));
});

test("比较：NFKC 把全角与半角、连字、兼容字符归到同一个写法", () => {
  assert.equal(comparablePdfText("（ＵＳＤ／ＣＮＹ）１６：００"), "(USD/CNY)16:00");
  assert.equal(comparablePdfText(`e${at(0xfb03)}cient ${at(0xfb01)}nal`), "efficientfinal");
  // U+F9DC 是「隆」的兼容汉字
  assert.equal(comparablePdfText(at(0xf9dc)), at(0x9686));
});

test("比较：空白全部去掉，含换行、制表符、全角空格与不换行空格", () => {
  assert.equal(comparablePdfText(`第 1 条\n退款\t申请${at(0x3000)}的${at(0xa0)}规则`), "第1条退款申请的规则");
});

test("比较：连字符不参加比较，行末断词与本来带连字符的词都对得上", () => {
  assert.equal(comparablePdfText("reformulate the layers as learn- ing residual functions"), comparablePdfText("reformulate the layers as learning residual functions"));
  assert.equal(comparablePdfText("low/mid/high- level features"), comparablePdfText("low/mid/high-level features"));
  // U+2010 连字符、U+2011 不换行连字符、U+FF0D 全角连字符（NFKC 之后是连字符减号）
  assert.equal(comparablePdfText(`a${at(0x2010)}b${at(0x2011)}c${at(0xff0d)}d`), "abcd");
});

test("比较：仍然是逐字比较，字不同就不同", () => {
  assert.notEqual(comparablePdfText("平台应当在 2 个工作日内答复"), comparablePdfText("平台应当在 3 个工作日内答复"));
  // 破折号、减号不是连字符，留着
  assert.equal(comparablePdfText(`152 layers${at(0x2014)}8 ${at(0x2212)} 1`), `152layers${at(0x2014)}8${at(0x2212)}1`);
});

test("本文件不导入任何模块（页面也要导入它）", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "lib", "pdf_normalize.ts"), "utf-8");
  assert.doesNotMatch(source, /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']|(?:^|\n)\s*import\s*["']|\bimport\(/);
});
