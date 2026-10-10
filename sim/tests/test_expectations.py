"""「至少应有」清单的核对：按标题与别名、例子、问题的事项、条目的名称与语句找关键词组。"""

from __future__ import annotations

import unittest
from pathlib import Path

from sim import expectations
from sim.tests.test_lamps import item, page, question, task, use_case

REPO = Path(__file__).resolve().parents[2]

EXPECT = {
    "说明": "测试用的清单。",
    "总体分析": {"流程页": [["借书", "借阅"], ["续借"]], "角色页": [["服务台", "馆员"]]},
    "例外": {"借书": [["超过上限", "最多借"], ["有逾期", "逾期未还"]], "续借": [["有人预约"]]},
    "问题": [["寒暑假"], ["智能推荐"]],
    "功能用例": [["借书", "借阅"], ["预约"]],
    "非功能需求": [["每分钟", "性能"]],
    "约束": [["一角", "不超过定价"]],
}


def rows_of(items) -> dict:
    return {(r["部分"], expectations.group_label(r["组"])): r for r in expectations.check(EXPECT, task(items))}


class ExpectationTest(unittest.TestCase):
    def test_总体分析按标题与别名_例外在流程页的全部例子里找_是不是以例外开头只显示(self):
        rows = rows_of([
            page(1, "图书借阅", ["流程"], ["小王一次借了六本，超过上限，只登记到五本。", "例外：名下有逾期未还的书，不能再借。"]),
            page(2, "借书证", ["概念"], ["有逾期的人补办借书证要先还书。"]),
            page(3, "读者服务台", ["角色"], aliases=["馆员"]),
            page(4, "续借", ["流程"], status="已废弃"),
        ])
        flow = rows[("总体分析·流程页", "借书／借阅")]
        # 标题里有「借阅」的流程页与标题里有「借书」的概念页都命中；小节名里的种类不作条件，实际贴的标签带在结果里。
        self.assertEqual((flow["命中"], flow["命中的条目编号"], flow["页贴的标签"]), (True, ["OA-001", "OA-002"], {"OA-001": ["流程"], "OA-002": ["概念"]}))
        self.assertEqual(rows[("总体分析·角色页", "服务台／馆员")]["命中的词"], "服务台")
        # 已废弃的页不算。
        self.assertFalse(rows[("总体分析·流程页", "续借")]["命中"])
        # 例外：流程「借书」的页按同义写法找到两页，其中贴了流程标签的只有 OA-001，所以只看它的例子。
        over, overdue = rows[("例外·借书", "超过上限／最多借")], rows[("例外·借书", "有逾期／逾期未还")]
        self.assertEqual((over["命中"], over["以例外开头"], over["流程的页"]), (True, False, ["OA-001"]))
        self.assertEqual((overdue["命中"], overdue["以例外开头"], overdue["命中的词"]), (True, True, "有逾期"))
        # 这个流程的页找不到（续借那一页已废弃）：这一组不命中。
        self.assertEqual((rows[("例外·续借", "有人预约")]["命中"], rows[("例外·续借", "有人预约")]["流程的页"]), (False, []))

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

    def test_仓里的两份清单读得出来_每组都是关键词的列表(self):
        for name, flows in (("library-short.json", 5), ("library-long.json", 6)):
            expect = expectations.load(REPO / "sim" / "expectations" / name)
            self.assertEqual(len(expect["总体分析"]["流程页"]), flows)
            rows = expectations.check(expect, task([]))
            self.assertTrue(rows and not any(r["命中"] for r in rows))
            for row in rows:
                self.assertTrue(row["组"] and all(isinstance(word, str) and word for word in row["组"]))
            # 「例外」里每个流程的名字都能在「流程页」里找到它的同义写法。
            for flow in expect["例外"]:
                self.assertTrue(any(flow in group for group in expect["总体分析"]["流程页"]), flow)


if __name__ == "__main__":
    unittest.main()
