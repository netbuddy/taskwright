"""「至少应有」清单的核对：按标题与别名、例子、问题的事项、条目的名称与语句找关键词组。"""

from __future__ import annotations

import unittest
from pathlib import Path

from sim import expectations
from sim.tests.test_lamps import item, page, question, task, use_case

REPO = Path(__file__).resolve().parents[2]

EXPECT = {
    "说明": "测试用的清单。",
    "业务说明": {"流程页": [["借书", "借阅"], ["续借"]], "角色页": [["服务台", "馆员"]]},
    "例外": {"借书": [["超过上限", "最多借"], ["有逾期", "逾期未还"]], "续借": [["有人预约"]]},
    "问题": [["寒暑假"], ["智能推荐"]],
    "功能用例": [["借书", "借阅"], ["预约"]],
    "非功能需求": [["每分钟", "性能"]],
    "约束": [["一角", "不超过定价"]],
}


def rows_of(items) -> dict:
    return {(r["部分"], expectations.group_label(r["组"])): r for r in expectations.check(EXPECT, task(items))}


class ExpectationTest(unittest.TestCase):
    def test_业务说明按标题与别名_例外只在流程页以例外开头的例子里找(self):
        rows = rows_of([
            page(1, "图书借阅", ["流程"], ["小王一次借了六本，超过上限，只登记到五本。", "例外：名下有逾期未还的书，不能再借。"]),
            page(2, "借书证", ["概念"], ["有逾期的人补办借书证要先还书。"]),
            page(3, "读者服务台", ["角色"], aliases=["馆员"]),
            page(4, "续借", ["流程"], status="已废弃"),
        ])
        flow = rows[("业务说明·流程页", "借书／借阅")]
        # 标题里有「借阅」的流程页与标题里有「借书」的概念页都命中；小节名里的种类不作条件，实际贴的标签带在结果里。
        self.assertEqual((flow["命中"], flow["命中的条目编号"], flow["页贴的标签"]), (True, ["OA-001", "OA-002"], {"OA-001": ["流程"], "OA-002": ["概念"]}))
        self.assertEqual(rows[("业务说明·角色页", "服务台／馆员")]["命中的词"], "服务台")
        # 已废弃的页不算。
        self.assertFalse(rows[("业务说明·流程页", "续借")]["命中"])
        # 例外：流程「借书」的页按同义写法找到两页，其中贴了流程标签的只有 OA-001，所以只看它的例子。
        over, overdue = rows[("例外·借书", "超过上限／最多借")], rows[("例外·借书", "有逾期／逾期未还")]
        # 「超过上限」只出现在不以「例外：」开头的例子里：不命中，另外写出是哪一页提到了。
        self.assertEqual((over["命中"], over["命中的条目编号"], over["只在别的例子里提到的页"], over["流程的页"]), (False, [], ["OA-001"], ["OA-001"]))
        self.assertEqual((overdue["命中"], overdue["命中的条目编号"], overdue["只在别的例子里提到的页"], overdue["命中的词"]), (True, ["OA-001"], [], "有逾期"))
        self.assertNotIn("以例外开头", overdue)
        # 这个流程的页找不到（续借那一页已废弃）：这一组不命中。
        self.assertEqual((rows[("例外·续借", "有人预约")]["命中"], rows[("例外·续借", "有人预约")]["流程的页"]), (False, []))

    def test_例外的例子开头有空格照样认_句子中间的例外两个字与反例不算(self):
        rows = rows_of([
            page(1, "借书", ["流程"], ["  例外：一次借的书超过上限，多出来的不借。", "反例：名下有逾期未还的书也能借。", "小王遇到例外：有逾期，没借成。"]),
        ])
        over, overdue = rows[("例外·借书", "超过上限／最多借")], rows[("例外·借书", "有逾期／逾期未还")]
        self.assertEqual((over["命中"], over["命中的词"], over["只在别的例子里提到的页"]), (True, "超过上限", []))
        self.assertEqual((overdue["命中"], overdue["只在别的例子里提到的页"]), (False, ["OA-001"]))

    def test_问题按事项_功能用例按名称_非功能需求与约束按类别与需求语句(self):
        rows = rows_of([
            question(1),                                                           # 事项「寒暑假借期怎么算」
            item("TBD-002", "问题", {"事项": "推荐功能的范围", "种类": "待澄清", "状态": "未解决", "建议的处理": "智能推荐先不做"}),
            use_case(1),                                                           # 用例名称「借书」
            item("UC-002", "功能用例", {"用例名称": "还书", "基本流程": ["有预约的书转入预约架"]}),
            item("NFR-001", "非功能需求", {"类别": "性能", "句式类型": "普遍型", "需求语句": "系统应当在高峰期稳定运行。"}),
            item("CON-001", "约束", {"类别": "罚款", "句式类型": "普遍型", "需求语句": "逾期每本每天罚款一角。"}),
            item("CON-002", "约束", {"类别": "删掉的", "需求语句": "不超过定价。"}) | {"在第几次修订删除": 3},
        ])
        self.assertEqual(rows[("问题", "寒暑假")]["命中的条目编号"], ["TBD-001"])
        self.assertFalse(rows[("问题", "智能推荐")]["命中"])                       # 只出现在「建议的处理」里，不是事项
        self.assertEqual(rows[("功能用例", "借书／借阅")]["命中的条目编号"], ["UC-001"])
        self.assertFalse(rows[("功能用例", "预约")]["命中"])                       # 只出现在流程步骤里，不是名称
        self.assertEqual((rows[("非功能需求", "每分钟／性能")]["命中的词"], rows[("约束", "一角／不超过定价")]["命中的条目编号"]), ("性能", ["CON-001"]))

    def test_模型按图的种类在_Mermaid_文本里找_删掉的图与别的种类不算_部分写种类的键(self):
        def diagram(n: int, kind: str, texts: list[str], deleted: bool = False) -> dict:
            return {"图的编号": f"DG-{n:03d}", "流水号": n, "在第几次修订删除": len(texts) if deleted else None,
                    "修订内容": [{"修订号": i + 1, "图名": "借书的图", "种类": kind, "Mermaid 文本": text, "说明": "馆员"} for i, text in enumerate(texts)]}
        expect = {"模型": {"use_case": [["读者"], ["借书", "借阅"], ["馆员"]], "state": [["逾期"]], "sequence": [], "context": [["自助借还机"]]}}
        drawn = {"图": [
            diagram(1, "use_case", ["flowchart LR\n  读者 --> 旧的写法", "flowchart LR\n  读者 --> UC1(借阅图书)"]),   # 只看现在这一版
            diagram(2, "use_case", ["flowchart LR\n  读者 --> UC2(还书)"]),
            diagram(3, "use_case", ["flowchart LR\n  馆员 --> UC3(借书)"], deleted=True),                               # 删掉的不算
            diagram(4, "class", ["classDiagram\n  class 逾期"]),                                                        # 别的种类里写到了不算
            diagram(5, "context", ["flowchart LR\n  subgraph 系统\n  end\n  自助借还机 --> 系统"]),                    # 观测台不认得的种类照它的键认
        ]}
        rows = {(r["部分"], expectations.group_label(r["组"])): r for r in expectations.check(expect, {**task([]), **drawn})}
        self.assertEqual(list(rows), [("模型·use_case", "读者"), ("模型·use_case", "借书／借阅"), ("模型·use_case", "馆员"), ("模型·state", "逾期"),
                                      ("模型·context", "自助借还机")])
        reader, borrow, staff = rows[("模型·use_case", "读者")], rows[("模型·use_case", "借书／借阅")], rows[("模型·use_case", "馆员")]
        self.assertEqual((reader["命中"], reader["命中的条目编号"], reader["部分名"], reader["这一种的图"]), (True, ["DG-001", "DG-002"], "模型·用例图", ["DG-001", "DG-002"]))
        self.assertEqual((borrow["命中的条目编号"], borrow["命中的词"]), (["DG-001"], "借阅"))
        self.assertFalse(staff["命中"])                                            # 只在删掉的图与图的说明里
        self.assertEqual((rows[("模型·state", "逾期")]["命中"], rows[("模型·state", "逾期")]["这一种的图"], rows[("模型·state", "逾期")]["部分名"]),
                         (False, [], "模型·状态图"))
        boundary = rows[("模型·context", "自助借还机")]
        self.assertEqual((boundary["命中的条目编号"], expectations.section_label(boundary)),
                         (["DG-005"], "模型·" + expectations.taskdb.DIAGRAM_KIND_NAMES.get("context", "context")))
        self.assertEqual(expectations.section_label({"部分": "问题"}), "问题")

    def test_导语页小节对着导语所属章找_导语页不参加别的小节(self):
        expect = {"业务说明": {"流程页": [["借书", "借阅"], ["业务流程"]], "导语页": [["业务流程"], ["角色"], ["业务对象"]]}, "例外": {"借书": [["有逾期"]]}}
        rows = {(r["部分"], expectations.group_label(r["组"])): r for r in expectations.check(expect, task([
            page(1, "借书", ["流程"], ["例外：名下有逾期未还的书，不能再借。"]),
            page(2, "业务流程导语", examples=["例外：有逾期的借书另说。"], intro="业务流程"),
            page(3, "角色导语", intro="角色", status="已废弃"),
        ]))}
        hit = rows[("业务说明·导语页", "业务流程")]
        self.assertEqual((hit["命中"], hit["命中的条目编号"], hit["命中的词"]), (True, ["OA-002"], "业务流程"))
        self.assertNotIn("页贴的标签", hit)
        # 已废弃的导语页不算；没有立的章不命中。
        self.assertEqual((rows[("业务说明·导语页", "角色")]["命中"], rows[("业务说明·导语页", "业务对象")]["命中"]), (False, False))
        # 导语页的标题里有「业务流程」，但它不参加按标题找的小节，也不当作「借书」这个流程的页。
        self.assertFalse(rows[("业务说明·流程页", "业务流程")]["命中"])
        self.assertEqual(rows[("业务说明·流程页", "借书／借阅")]["命中的条目编号"], ["OA-001"])
        self.assertEqual(rows[("例外·借书", "有逾期")]["流程的页"], ["OA-001"])

    def test_仓里的两份清单读得出来_每组都是关键词的列表(self):
        for name, flows in (("library-short.json", 5), ("library-long.json", 6)):
            expect = expectations.load(REPO / "sim" / "expectations" / name)
            self.assertEqual(len(expect["业务说明"]["流程页"]), flows)
            self.assertEqual([group[0] for group in expect["业务说明"]["导语页"]], ["概述与范围", "角色", "业务流程", "业务对象", "业务目标"])
            self.assertIn("「导语页」小节每组写的是章名", expect["说明"])
            rows = expectations.check(expect, task([]))
            self.assertTrue(rows and not any(r["命中"] for r in rows))
            # 「模型」一节按图的种类键分六个小节，时序图那一节是空的；任务里没有图时每组都不命中，「这一种的图」是空的。
            models = [r for r in rows if r["部分"].startswith("模型·")]
            self.assertEqual(list(expect["模型"]), ["context", "use_case", "class", "state", "flowchart", "sequence"])
            self.assertEqual((len(models), expect["模型"]["sequence"]), (sum(len(groups) for groups in expect["模型"].values()), []))
            self.assertGreater(len(models), 20)
            self.assertEqual({r["部分"] for r in models}, {f"模型·{kind}" for kind, groups in expect["模型"].items() if groups})
            self.assertTrue(all(r["这一种的图"] == [] and r["部分名"].startswith("模型·") for r in models))
            self.assertNotIn("都是空的", expect["说明"])
            self.assertIn("「模型」一节按图的种类分小节", expect["说明"])
            for row in rows:
                self.assertTrue(row["组"] and all(isinstance(word, str) and word for word in row["组"]))
            # 「例外」里每个流程的名字都能在「流程页」里找到它的同义写法。
            for flow in expect["例外"]:
                self.assertTrue(any(flow in group for group in expect["业务说明"]["流程页"]), flow)


if __name__ == "__main__":
    unittest.main()
