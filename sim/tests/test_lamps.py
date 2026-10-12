"""评测的灯：二十一盏。在这里算的九盏各一组正反例（手写的任务数据）；整盏从产品取的十二盏看三种结果怎样换成这里的说法；
另有一例经真实的库、命令行入口与完成条件核对走一遍。"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from sim import lamps

REPO = Path(__file__).resolve().parents[2]
COLLECTIONS = [{"名称": name} for name in ("功能用例", "非功能需求", "约束", "问题", "总体分析")]


def content(fields: dict, sources=(), reviews=(), waivers=(), rev: int = 1) -> dict:
    return {"修订号": rev, "字段": fields, "来源": list(sources), "评审记录": list(reviews), "保留记录": list(waivers), "确认记录": []}


def page(n: int, title: str, tags=(), examples=(), aliases=(), parent=(), status: str = "在用", sources=(), rev: int = 1, intro: str | None = None) -> dict:
    now = content({"标题": title, "别名": list(aliases), "它是什么": f"{title}是什么。", "例子": list(examples), "标签": list(tags),
                   "上级主题": list(parent), "状态": status, **({"导语所属章": intro} if intro is not None else {})}, sources, rev=rev)
    return {"条目编号": f"OA-{n:03d}", "所属集合": "总体分析", "在第几次修订删除": None, "当前内容": now, "修订内容": [now]}


def item(item_id: str, collection: str, fields: dict, sources=(), reviews=(), waivers=()) -> dict:
    now = content(fields, sources, reviews, waivers)
    return {"条目编号": item_id, "所属集合": collection, "在第几次修订删除": None, "当前内容": now, "修订内容": [now]}


def use_case(n: int, sources=(), reviews=(), waivers=()) -> dict:
    return item(f"UC-{n:03d}", "功能用例", {"用例名称": "借书"}, sources, reviews, waivers)


def question(n: int, refs=(), kind: str = "待澄清", state: str = "未解决", sources=()) -> dict:
    return item(f"TBD-{n:03d}", "问题", {"事项": "寒暑假借期怎么算", "种类": kind, "状态": state, "关联条目": list(refs)}, sources)


def cites(page_id: str) -> dict:
    return {"种类": "条目", "出处": page_id, "摘录": "……", "支持": []}


def quote(locator: str) -> dict:
    return {"种类": "文档原文", "出处": locator, "摘录": "……", "支持": []}


def viewed(item_id: str, rev: int = 1, attitude: str = "接受", basis: str = "已读") -> dict:
    return {"依据": [{"依据": basis}], "明细": [{"条目编号": item_id, "修订号": rev, "态度": attitude}]}


def task(items, marks=(), collections=COLLECTIONS) -> dict:
    return {"任务编号": "TASK-T", "任务定义": {"集合": collections, "完成条件": {}}, "条目": list(items), "判读": list(marks)}


def one(key: str, items, facts: dict | None = None, materials=(), completion=None, marks=()) -> tuple[str, list[str]]:
    found = [x for x in lamps.compute(task(items, marks), facts if facts is not None else {"mentions": {}, "verification": {}},
                                      list(materials), completion) if x["键"] == key][0]
    return found["结果"], found["差的条目编号"]


class LampTest(unittest.TestCase):
    def test_一共二十一盏_按六个阶段分组_通过与否只有通过和未通过两种有值(self):
        out = lamps.compute(task([page(1, "借书", ["流程"])]), None, [], None)
        self.assertEqual(len(out), 21)
        self.assertEqual(lamps.STAGES, ("核读材料", "澄清", "整理建模", "写条目", "评审确认", "编写文档"))
        self.assertEqual([x["键"] for x in out if x["阶段"] == "整理建模"],
                         ["roles_in_context_and_use_cases", "concepts_related_in_class", "flows_have_flowchart_with_branch", "stateful_concepts_have_state",
                          "no_duplicate_titles", "no_untagged_pages", "rules_no_conflict"])
        self.assertEqual([x["键"] for x in out if x["阶段"] == "写条目"],
                         ["flows_backed_by_use_cases", "basis_pages_viewed", "basis_diagrams_viewed", "no_pending_items", "no_blocking_questions", "no_pending_marks"])
        self.assertEqual([x["键"] for x in out if x["阶段"] == "编写文档"], ["chapters_have_intro", "glossary_complete", "document_no_blocking_questions"])
        self.assertEqual([x["阶段"] for x in out], [s for s, _k, _t in lamps.LAMPS])
        self.assertEqual(sorted({x["阶段"] for x in out}, key=lamps.STAGES.index), list(lamps.STAGES))
        for x in out:
            self.assertEqual(x["通过"], {"通过": True, "未通过": False}.get(x["结果"]))
        self.assertEqual([x["键"] for x in lamps.compute(task([]), None, [], None, stage="澄清")],
                         ["tagged_pages_no_open_questions", "decisions_have_goal"])

    def test_任务定义里没有总体分析集合_每盏都不适用(self):
        out = lamps.compute(task([use_case(1)], collections=[{"名称": "功能用例"}, {"名称": "领域说明"}]), None, ["a.md"], [])
        self.assertEqual({x["结果"] for x in out}, {"不适用"})

    def test_每份材料都被主题页或问题引用(self):
        cited = [page(1, "借书", sources=[quote("inputs/a.md")]), question(1, sources=[quote("inputs/b.docx#p12")])]
        self.assertEqual(one("materials_cited", cited, materials=["a.md", "b.docx"]), ("通过", []))
        only_use_case = [page(1, "借书", sources=[quote("inputs/a.md")]), use_case(1, [quote("inputs/b.docx#p3")])]
        found = [x for x in lamps.compute(task(only_use_case), {}, ["a.md", "b.docx"], None) if x["键"] == "materials_cited"][0]
        self.assertEqual((found["结果"], found["差的材料"], found["备注"]), ("未通过", ["b.docx"], "没有被引用的材料：b.docx。"))
        self.assertEqual(one("materials_cited", cited)[0], "不适用")

    def test_贴了标签的页没有挂着未解决的待澄清问题(self):
        pages = [page(1, "借书", ["流程"]), page(2, "草稿")]
        self.assertEqual(one("tagged_pages_no_open_questions", [*pages, question(1, ["OA-001"], state="已解决"),
                                                                question(2, ["OA-001"], kind="范围外"), question(3, ["OA-002"])]), ("通过", []))
        self.assertEqual(one("tagged_pages_no_open_questions", [*pages, question(1, ["OA-001"])]), ("未通过", ["OA-001"]))
        self.assertEqual(one("tagged_pages_no_open_questions", [page(2, "草稿"), question(1, ["OA-002"])])[0], "不适用")

    def test_决定页有上级目标页(self):
        goal, other = page(1, "替换纸质登记", ["目标"]), page(2, "借书", ["流程"])
        self.assertEqual(one("decisions_have_goal", [goal, other, page(3, "历史记录一次迁入", ["决定"], parent=["OA-001"])]), ("通过", []))
        self.assertEqual(one("decisions_have_goal", [goal, other, page(3, "历史记录一次迁入", ["决定"], parent=["OA-002"]),
                                                     page(4, "不收现金", ["决定"])]), ("未通过", ["OA-003", "OA-004"]))
        self.assertEqual(one("decisions_have_goal", [goal, other])[0], "不适用")

    def test_从产品取的十二盏_三种结果换成这里的说法_取不到时是算不了(self):
        pages = [page(1, "读者", ["角色"]), page(2, "借书", ["流程"])]
        product = {"lamps": {
            "roles_in_context_and_use_cases": {"ok": False, "items": ["OA-001"], "summary": "有 1 页标签为「角色」的主题还没有同时画进系统边界图与用例图：OA-001（用例图里没有）。"},
            "flows_have_flowchart_with_branch": {"ok": True, "items": [], "summary": "每个标签为「流程」的主题都有一张带判断分叉的流程图。"},
            "concepts_related_in_class": {"ok": None, "items": [], "summary": "还没有标签为「概念」的主题。"},
            "no_blocking_questions": {"ok": False, "items": ["TBD-002"], "summary": "有 1 个阻断下游的问题还没有了结：TBD-002。"},
            "no_pending_marks": {"ok": True, "items": [], "summary": "图、页与条目里没有标为待定的地方。"},
            "chapters_have_intro": {"ok": False, "items": [], "summary": "有 1 章还没有导语：「业务流程」。"},
            "glossary_complete": {"ok": None, "items": [], "summary": "还没有标签为「概念」的主题。"},
        }}
        found = {x["键"]: x for x in lamps.compute(task(pages), product, [], None)}
        self.assertEqual((found["roles_in_context_and_use_cases"]["结果"], found["roles_in_context_and_use_cases"]["差的条目编号"], found["roles_in_context_and_use_cases"]["备注"]),
                         ("未通过", ["OA-001"], "有 1 页标签为「角色」的主题还没有同时画进系统边界图与用例图：OA-001（用例图里没有）。"))
        self.assertEqual((found["flows_have_flowchart_with_branch"]["结果"], found["flows_have_flowchart_with_branch"]["差的条目编号"], found["flows_have_flowchart_with_branch"]["备注"]),
                         ("通过", [], ""))
        self.assertEqual((found["concepts_related_in_class"]["结果"], found["concepts_related_in_class"]["备注"]), ("不适用", "还没有标签为「概念」的主题。"))
        # 新加的五盏照样换：差的是问题条目的编号；差的是章的那一盏没有编号，备注里写着是哪一章。
        self.assertEqual((found["no_blocking_questions"]["结果"], found["no_blocking_questions"]["差的条目编号"]), ("未通过", ["TBD-002"]))
        self.assertEqual((found["no_pending_marks"]["结果"], found["no_pending_marks"]["备注"]), ("通过", ""))
        self.assertEqual((found["chapters_have_intro"]["结果"], found["chapters_have_intro"]["差的条目编号"], found["chapters_have_intro"]["备注"]),
                         ("未通过", [], "有 1 章还没有导语：「业务流程」。"))
        self.assertEqual(found["glossary_complete"]["结果"], "不适用")
        self.assertEqual(found["document_no_blocking_questions"]["结果"], "算不了")
        # 产品这一次没有给出某一盏（例如命令行入口是旧的）：算不了，写明原因。
        self.assertEqual((found["rules_no_conflict"]["结果"], found["rules_no_conflict"]["备注"]), ("算不了", "产品没有给出这盏灯的结果。"))
        # 命令行入口调不动：十二盏都是算不了，原因照入口给的。
        down = {x["键"]: x for x in lamps.compute(task(pages), None, [], None, facts_problem="本机找不到 node。")}
        self.assertEqual({(down[key]["结果"], down[key]["通过"], down[key]["备注"]) for key in lamps.PRODUCT_LAMPS}, {("算不了", None, "本机找不到 node。")})
        self.assertEqual(len(lamps.PRODUCT_LAMPS), 12)

    def test_没有两页的标题或别名相同(self):
        self.assertEqual(one("no_duplicate_titles", [page(1, "借书", aliases=["借阅"]), page(2, "还书", aliases=["归还"])]), ("通过", []))
        self.assertEqual(one("no_duplicate_titles", [page(1, "借书", aliases=["借阅"]), page(2, "借阅 "), page(3, "还书")]), ("未通过", ["OA-001", "OA-002"]))
        # 与已废弃的页重名不算；一页都没有时不适用。
        self.assertEqual(one("no_duplicate_titles", [page(1, "借书"), page(2, "借书", status="已废弃")]), ("通过", []))
        self.assertEqual(one("no_duplicate_titles", [use_case(1)])[0], "不适用")

    def test_没有未归类的页(self):
        self.assertEqual(one("no_untagged_pages", [page(1, "借书", ["流程"]), page(2, "旧说法", status="已废弃")]), ("通过", []))
        self.assertEqual(one("no_untagged_pages", [page(1, "借书", ["流程"]), page(2, "借期")]), ("未通过", ["OA-002"]))
        self.assertEqual(one("no_untagged_pages", [])[0], "不适用")
        # 导语页不贴标签，不算未归类；「导语所属章」空着的照旧算。
        self.assertEqual(one("no_untagged_pages", [page(1, "借书", ["流程"]), page(2, "业务流程导语", intro="业务流程")]), ("通过", []))
        self.assertEqual(one("no_untagged_pages", [page(1, "借书", ["流程"]), page(2, "业务流程导语", intro=" ")]), ("未通过", ["OA-002"]))
        self.assertEqual((lamps.is_intro(page(2, "业务流程导语", intro="业务流程")), lamps.is_intro(page(1, "借书", ["流程"]))), (True, False))

    def test_条目依据的页都是用户看过的(self):
        pages = [page(1, "借书", ["流程"], rev=2), page(2, "读者", ["角色"])]
        uc = use_case(1, [cites("OA-001"), cites("OA-002")])
        self.assertEqual(one("basis_pages_viewed", [*pages, uc], marks=[viewed("OA-001", 2), viewed("OA-002")]), ("通过", []))
        # 看的是旧修订、最近一条是撤回、依据是界面修改，这三种都不算看过。
        self.assertEqual(one("basis_pages_viewed", [*pages, uc], marks=[viewed("OA-001", 1), viewed("OA-002")]), ("未通过", ["UC-001"]))
        self.assertEqual(one("basis_pages_viewed", [*pages, uc], marks=[viewed("OA-001", 2), viewed("OA-002"), viewed("OA-002", attitude="不接受")]),
                         ("未通过", ["UC-001"]))
        self.assertEqual(one("basis_pages_viewed", [*pages, uc], marks=[viewed("OA-001", 2), viewed("OA-002", basis="界面修改")]), ("未通过", ["UC-001"]))
        self.assertEqual(one("basis_pages_viewed", [*pages, use_case(1, [quote("inputs/a.md")])])[0], "不适用")

    def test_没有待核实的条目(self):
        items = [page(1, "借书", ["流程"]), use_case(1), item("CON-001", "约束", {"类别": "时限"}), question(1)]
        clear = {"verification": {"UC-001": {"pending_verification": False, "basis_pending": None},
                                  "OA-001": {"pending_verification": True, "basis_pending": None}}}
        self.assertEqual(one("no_pending_items", items, clear), ("通过", []))       # 主题页自己待核实不归这一盏
        pending = {"verification": {"UC-001": {"pending_verification": True, "basis_pending": None},
                                    "CON-001": {"pending_verification": False, "basis_pending": {"item_id": "OA-001", "reason": "pending", "see": None}}}}
        self.assertEqual(one("no_pending_items", items, pending), ("未通过", ["UC-001", "CON-001"]))
        self.assertEqual(one("no_pending_items", [page(1, "借书")], clear)[0], "不适用")

    def test_评审没有未处理的发现(self):
        ok, bad = [{"结论": "合规"}], [{"结论": "合规"}, {"结论": "不合规"}]
        pages = [page(1, "借书", ["流程"])]
        self.assertEqual(one("reviews_no_open_findings", [*pages, use_case(1, reviews=ok), use_case(2, reviews=[{"结论": "不合规"}, {"结论": "合规"}]),
                                                          use_case(3, reviews=bad, waivers=[{"已撤销": False}]), use_case(4)]), ("通过", []))
        self.assertEqual(one("reviews_no_open_findings", [*pages, use_case(1, reviews=bad), use_case(2, reviews=bad, waivers=[{"已撤销": True}]),
                                                          use_case(3, reviews=ok)]), ("未通过", ["UC-001", "UC-002"]))
        found = [x for x in lamps.compute(task([*pages, use_case(1)]), {}, [], None) if x["键"] == "reviews_no_open_findings"][0]
        self.assertEqual((found["结果"], found["备注"]), ("未通过", "这个任务还没有评审过。"))

    def test_完成条件全部满足(self):
        pages = [page(1, "借书", ["流程"])]
        met = [{"collection": "功能用例", "condition": "至少一个条目", "state": "met", "unmet": []},
               {"collection": "约束", "condition": "每个条目评审通过", "state": "empty", "unmet": []}]
        self.assertEqual(one("completion_met", pages, completion=met), ("通过", []))
        unmet = [*met, {"collection": "功能用例", "condition": "每个条目用户确认", "state": "unmet",
                        "unmet": [{"item": "UC-002", "reason": "……"}, {"item": "UC-001", "reason": "……"}]}]
        found = [x for x in lamps.compute(task(pages), {}, [], unmet) if x["键"] == "completion_met"][0]
        self.assertEqual((found["结果"], found["差的条目编号"], found["备注"]), ("未通过", ["UC-001", "UC-002"], "还差：「功能用例」每个条目用户确认。"))
        self.assertEqual(one("completion_met", pages, completion=None)[0], "算不了")


# 建任务目录与写库都用产品自己的函数；发起方写用户，所以不受助手一侧的几道核对拦着。
CREATE = r"""
import { createTaskDir } from "./backend/src/workspace.ts";
process.stdout.write(JSON.stringify(createTaskDir(process.argv[1], "srs-authoring", null, null, "TASK-T")));
"""
SAVE = r"""
import { saveRevision } from "./agent/src/lib/save_revision.ts";
const dir = process.argv[1];
const src = (excerpt) => ({ kind: "文档原文", locator: "inputs/材料.md", excerpt });
saveRevision({ workspaceDir: dir, sessionId: "s", callId: "ui-op-1", actor: "user" }, { operations: [
  { op: "add", collection: "总体分析", fields: { 标题: "借书", 它是什么: "读者凭借书证借书。", 例子: ["例外：读者名下有逾期未还的书，不能再借。"],
    标签: ["流程"], 状态: "在用" }, sources: [src("读者凭借书证借书")] },
  { op: "add", collection: "总体分析", fields: { 标题: "读者", 它是什么: "办了借书证的人。", 标签: ["角色"], 状态: "在用" }, sources: [src("读者")] },
] });
saveRevision({ workspaceDir: dir, sessionId: "s", callId: "ui-op-2", actor: "user" }, { operations: [
  { op: "add", collection: "功能用例", fields: { 用例名称: "借书", 用例功能: "读者凭借书证借书。", 参与者: ["读者"], 基本流程: ["读者出示借书证", "系统登记借书"] },
    sources: [{ kind: "条目", locator: "OA-001", excerpt: "读者凭借书证借书。" }, { kind: "助手补充", excerpt: "按常识补了出示借书证这一步" }] },
  { op: "add", collection: "问题", fields: { 事项: "寒暑假借期怎么算", 种类: "待澄清", 是否阻断下游: "不阻断", 何时回看: "评审确认时", 状态: "未解决", 关联条目: ["OA-001"] }, sources: [src("读者凭借书证借书")] },
] });
"""
VIEW = r"""
import { runUserOperation } from "./agent/src/lib/user_ops.ts";
runUserOperation({ workspaceDir: process.argv[1], sessionId: "s" }, { op_id: "ui-op-3", kind: "mark_viewed", targets: [{ item_id: "OA-001", base_revision: 1 }] });
"""


def node(script: str, arg: str) -> str:
    return subprocess.run(["node", "--input-type=module", "-e", script, arg], cwd=str(REPO), check=True, capture_output=True, text=True).stdout


def copy_db(task_dir: Path, sim: Path) -> None:
    (sim / "库副本").mkdir(parents=True, exist_ok=True)
    for f in task_dir.glob("task.sqlite*"):
        shutil.copy2(f, sim / "库副本" / f.name)
    shutil.copytree(task_dir / "docs", sim / "库副本" / "docs", dirs_exist_ok=True)


@unittest.skipUnless(shutil.which("node"), "本机没有 node")
class SimLampTest(unittest.TestCase):
    def test_从演练目录的库副本算_待核实与提到经命令行入口_完成条件经核对函数(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim = Path(tmp) / "sim-001"
            task_dir = Path(json.loads(node(CREATE, str(sim / "tasks" / "TASK-T")))["任务目录"])
            (task_dir / "inputs").mkdir(exist_ok=True)
            (task_dir / "inputs" / "材料.md").write_text("读者凭借书证借书，每本书可以续借一次。", encoding="utf-8")
            node(SAVE, str(task_dir))
            (sim / "materials").mkdir()
            (sim / "materials" / "材料.md").write_text("读者凭借书证借书，每本书可以续借一次。", encoding="utf-8")
            copy_db(task_dir, sim)
            before = lamps.lamps_for_sim(sim)
            node(VIEW, str(task_dir))
            copy_db(task_dir, sim)
            after = lamps.lamps_for_sim(sim)
            empty = lamps.lamps_for_sim(Path(tmp) / "sim-002")
        self.assertEqual(before["任务编号"], "TASK-T")
        state = {x["键"]: (x["结果"], x["差的条目编号"]) for x in before["灯"]}
        self.assertEqual(state, {
            "materials_cited": ("通过", []),
            "tagged_pages_no_open_questions": ("未通过", ["OA-001"]),
            "decisions_have_goal": ("不适用", []),
            "roles_in_context_and_use_cases": ("未通过", ["OA-002"]),      # 角色页「读者」还没有画进任何一张图
            "concepts_related_in_class": ("不适用", []),
            "flows_have_flowchart_with_branch": ("未通过", ["OA-001"]),   # 流程页「借书」还没有流程图
            "stateful_concepts_have_state": ("不适用", []),
            "no_duplicate_titles": ("通过", []),
            "no_untagged_pages": ("通过", []),
            "rules_no_conflict": ("不适用", []),                          # 两页都没有写「已经定下的」
            "flows_backed_by_use_cases": ("通过", []),
            "basis_pages_viewed": ("未通过", ["UC-001"]),          # 用例依据的页用户还没看过
            "basis_diagrams_viewed": ("不适用", []),
            "no_pending_items": ("未通过", ["UC-001"]),            # 用例上有助手补充而用户没有确认
            "no_blocking_questions": ("通过", []),                 # 那一条问题写的是不阻断
            "no_pending_marks": ("通过", []),
            "reviews_no_open_findings": ("未通过", []),            # 还没有评审过
            "completion_met": state["completion_met"],
            "chapters_have_intro": ("未通过", []),                 # 角色、业务流程两章有内容而没有导语；差的是章，没有条目编号
            "glossary_complete": ("不适用", []),                   # 没有标签为「概念」的页
            "document_no_blocking_questions": ("通过", []),
        })
        self.assertEqual(state["completion_met"][0], "未通过")
        self.assertIn("UC-001", state["completion_met"][1])
        # 用户看过那一页之后，依据它的用例这一盏通过。
        self.assertEqual({x["键"]: x["结果"] for x in after["灯"]}["basis_pages_viewed"], "通过")
        # 没有库副本的那一遍：每盏都算不了，写明原因。
        self.assertEqual({(x["结果"], x["备注"]) for x in empty["灯"]}, {("算不了", "这一遍没有库副本（演练没有跑完）。")})
        self.assertEqual(len(empty["灯"]), 21)


if __name__ == "__main__":
    unittest.main()
