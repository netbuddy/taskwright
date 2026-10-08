/**
 * 知识库按字面查找的切词与打分（src/knowledge_keywords.ts）：汉字相邻两字一组、字母数字串小写成词、「第 N 条」整体另记一词、
 * 连字符与小数点是分隔、不还原单复数、不去数字前后的空白；BM25 的公式与参数；打分的对象是标题加正文。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BM25_B, BM25_K1, keywordIndex, keywordRanking, tokenize } from "../src/knowledge_keywords.ts";

test("汉字切成相邻两个字一组，单独一个汉字自成一词；标点与空白只是分隔", () => {
  assert.deepEqual(tokenize("逾期罚款"), ["逾期", "期罚", "罚款"]);
  assert.deepEqual(tokenize("借，还。 续借"), ["借", "还", "续借"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("　 \n！"), []);
});

test("字母与数字连成一个词并转成小写；连字符、小数点、斜杠、下划线都是分隔；不还原单复数；不去数字前后的空白", () => {
  assert.deepEqual(tokenize("Refund"), ["refund"]);
  // 单复数是两个词。
  assert.deepEqual(tokenize("refund/refunds"), ["refund", "refunds"]);
  assert.notDeepEqual(tokenize("refund"), tokenize("refunds"));
  // 连字符与版本号。
  assert.deepEqual(tokenize("self-service"), ["self", "service"]);
  assert.deepEqual(tokenize("v1.2"), ["v1", "2"]);
  assert.deepEqual(tokenize("ISO_8601"), ["iso", "8601"]);
  // 「HTTP 200」是两个词，不并成一个。
  assert.deepEqual(tokenize("HTTP 200"), ["http", "200"]);
  // 中英混排：汉字与字母各切各的。
  assert.deepEqual(tokenize("调用API超时"), ["调用", "api", "超时"]);
});

test("「第 N 条」另外整体记成一个词，中间有没有空格都算：两种写法切出来有同一个词", () => {
  assert.deepEqual(tokenize("第 8 条"), ["第8条", "第", "8", "条"]);
  assert.deepEqual(tokenize("第8条"), ["第8条", "第", "8", "条"]);
  assert.ok(tokenize("见第  269  条的规定").includes("第269条"));
  // 条号不同是不同的词；「第八条」这种汉字写法不另记。
  assert.ok(!tokenize("第 18 条").includes("第8条"));
  assert.deepEqual(tokenize("第八条"), ["第八", "八条"]);
});

const CHUNKS = [
  { heading: "借阅规范 / 逾期", text: "第 6 条 逾期每册每天罚款 0.5 元。" },
  { heading: "借阅规范 / 借阅", text: "第 3 条 读者凭借书证借书，每证最多同时借 5 册。" },
  { heading: null, text: "第 16 条 图书丢失的，按定价的三倍赔偿。" },
  { heading: "罚款", text: "正文里没有这个词。" },
];

test("打分的对象是标题加正文；只给得分大于 0 的片段，分高的在前，同分的下标小的在前", () => {
  const index = keywordIndex(CHUNKS);
  assert.equal(index.counts.length, 4);
  assert.deepEqual(index.lengths, CHUNKS.map((c) => tokenize(`${c.heading ?? ""}\n${c.text}`).length));
  // 「罚款」在第 1 个片段的正文里、第 4 个片段的标题里：两个都有分；别的没有。
  assert.deepEqual(keywordRanking(index, "罚款").map((one) => one.i).sort(), [0, 3]);
  // 条号：两种写法的结果完全相同，只命中第 6 条那一个片段排第一（「第」「条」「6」单字也各有一点分）。
  const spaced = keywordRanking(index, "第 6 条");
  assert.deepEqual(spaced, keywordRanking(index, "第6条"));
  assert.equal(spaced[0].i, 0);
  assert.ok(spaced[0].score > spaced[1].score);
  // 一个词都对不上：空的。
  assert.deepEqual(keywordRanking(index, "退货运费"), []);
  assert.deepEqual(keywordRanking(index, ""), []);
  assert.deepEqual(keywordRanking(keywordIndex([]), "罚款"), []);
  // 同分：下标小的在前。
  const same = keywordIndex([{ heading: null, text: "续借一次" }, { heading: null, text: "续借一次" }]);
  assert.deepEqual(keywordRanking(same, "续借").map((one) => one.i), [0, 1]);
});

test("BM25 的公式与参数：k1 是 1.2，b 是 0.75，idf 是 ln(1 + (N − df + 0.5) / (df + 0.5))，长度按词数", () => {
  assert.deepEqual([BM25_K1, BM25_B], [1.2, 0.75]);
  const chunks = [{ heading: null, text: "罚款 罚款 上限" }, { heading: null, text: "借期" }, { heading: null, text: "续借 预约 赔偿 丢失" }];
  const index = keywordIndex(chunks);
  // 第 1 个片段 3 个词，第 2 个 1 个，第 3 个 4 个：平均 8/3。
  assert.deepEqual(index.lengths, [3, 1, 4]);
  const idf = Math.log(1 + (3 - 1 + 0.5) / (1 + 0.5));
  const expected = (idf * 2 * 2.2) / (2 + 1.2 * (0.25 + 0.75 * (3 / (8 / 3))));
  const got = keywordRanking(index, "罚款");
  assert.equal(got.length, 1);
  assert.ok(Math.abs(got[0].score - expected) < 1e-12, `${got[0].score} 与 ${expected}`);
  // 要找的话里同一个词写两遍不重复算分。
  assert.deepEqual(keywordRanking(index, "罚款 罚款"), got);
});
