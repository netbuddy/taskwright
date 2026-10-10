"""批处理汇总：读每次的判定摘要，逐次列出；中途出错的那次写出错原因。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from sim.launch_user import load_profile, user_agent_session
from sim.run import batch_summary, build_parser, code_version, executor_tools, profile_model, used_model

SUMMARY = {"演练": "sim-004", "有效": True, "停止原因": "用户 agent 表示目标达成", "轮数": 7,
           "第一层": {"没有在执行者没问的时候主动说出隐藏事实（查全部轮次）": True, "点「确认」之前在同一轮里看过该条目的详情": True},
           "第一层说明": {"没有在执行者没问的时候主动说出隐藏事实（查全部轮次）": "没有。"},
           "第二层": {"check_db 全过": True, "隐藏事实被问出来：红冲＋线下＋客服": False},
           "第二层说明": {"隐藏事实被问出来：红冲＋线下＋客服": "没有一个条目里关键词组全部出现"},
           "隐藏事实": [{"写进了条目": ["CON-001"], "问出来了": True, "主动说出的轮次": None},
                        {"写进了条目": [], "问出来了": False, "主动说出的轮次": None}],
           "被工具拒绝次数": 2, "来源种类": {"文档原文": 9}, "助手补充累计": 3, "执行者读材料": {"需求.md": 2}}


class BatchSummaryTest(unittest.TestCase):
    def test_逐次一行_出错的写原因_每次一节带记录目录(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ok, bad = root / "sim-004", root / "sim-005"
            ok.mkdir(), bad.mkdir()
            (ok / "判定摘要.json").write_text(json.dumps(SUMMARY, ensure_ascii=False), encoding="utf-8")
            (ok / "record.json").write_text(json.dumps({"代码版本": {"提交号": "381970fb1670", "未提交的改动": ["agent/src/extension.ts"]},
                                                        "执行者工具清单": ["read", "ls", "reply"]}, ensure_ascii=False), encoding="utf-8")
            path = batch_summary(root, [ok, bad], {"sim-005": "RuntimeError：后端没起来"}, "librarian.json")
            text = path.read_text(encoding="utf-8")
        self.assertEqual(path.name, "批处理汇总_sim-004到sim-005.md")
        self.assertIn("| sim-004 | 381970f（另有未提交的改动） | read、ls、reply | 用户 agent 表示目标达成 | 7 | 有效 | 1／2 | 1／2 | 没有 | 2 | 需求.md 读了 2 次 |", text)
        self.assertIn("| sim-005 | | | 出错：RuntimeError：后端没起来 |", text)
        self.assertIn(f"- 记录目录：{ok}", text)
        self.assertIn("  - 不通过：隐藏事实被问出来：红冲＋线下＋客服。没有一个条目里关键词组全部出现", text)
        self.assertIn("「助手补充」全部修订累计 3 条", text)


    def test_部分有效写明从第几轮起作废_用户主动补充列轮次(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sim = root / "sim-007"
            sim.mkdir()
            summary = dict(SUMMARY, 演练="sim-007", 有效=False, 有效性="部分有效", 作废起始轮=5,
                           用户主动补充=[{"轮": 4, "事实": "发票红冲的单子转客服线下处理。"}])
            (sim / "判定摘要.json").write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")
            (sim / "record.json").write_text(json.dumps({}, ensure_ascii=False), encoding="utf-8")
            text = batch_summary(root, [sim], {}, "librarian.json").read_text(encoding="utf-8")
        self.assertIn("| 部分有效（第 5 轮起作废） |", text)
        self.assertIn("| 第 4 轮 |", text)
        self.assertIn("- 第一层：部分有效", text)


class RecordVersionTest(unittest.TestCase):
    def test_执行者工具清单取后端附记里最后一次报上来的(self):
        with tempfile.TemporaryDirectory() as tmp:
            sim = Path(tmp)
            events = sim / "backend" / "TASK-X" / "pi-events"
            events.mkdir(parents=True)
            lines = [{"种类": "实际工具清单", "工具": ["read", "ls"]}, {"种类": "别的"}, {"种类": "实际工具清单", "工具": ["read", "ls", "reply"]}]
            (events / "service-1.backend.jsonl").write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n不是 JSON\n",
                                                            encoding="utf-8")
            self.assertEqual(executor_tools(sim), ["read", "ls", "reply"])
            self.assertIsNone(executor_tools(sim / "没有"))

    def test_代码版本有提交号与未提交文件清单(self):
        version = code_version()
        # 不在 git 仓库里（例如刚解压的源码包）时提交号为 None
        if version["提交号"] is not None:
            self.assertRegex(version["提交号"], r"^[0-9a-f]{40}$")
        self.assertIsInstance(version["未提交的改动"], list)

    def test_实际用的模型取事件流里最后一条助手消息上写的_后端附记与时刻索引不算(self):
        with tempfile.TemporaryDirectory() as tmp:
            events = Path(tmp) / "backend" / "TASK-1" / "pi-events"
            events.mkdir(parents=True)
            line = lambda **message: json.dumps({"type": "message_end", "message": message}, ensure_ascii=False)      # noqa: E731
            (events / "service-1.jsonl").write_text("\n".join([
                line(role="user", content="整理需求"), line(role="assistant", provider="服务甲", model="模型一"), "这一行不是 JSON",
                line(role="assistant", provider="服务乙", model="模型二")]) + "\n", encoding="utf-8")
            (events / "service-1.backend.jsonl").write_text(line(role="assistant", provider="附记", model="不算") + "\n", encoding="utf-8")
            self.assertEqual(used_model(Path(tmp) / "backend"), "服务乙/模型二")
            self.assertIsNone(used_model(Path(tmp) / "user-agent"))


class RunOptionsTest(unittest.TestCase):
    def test_两个参数不给时与原来相同_给了就换后端的启动配置与用户_agent_的模型(self):
        args = build_parser().parse_args(["--persona", "p.json"])
        self.assertEqual((args.profile, args.user_model, args.max_rounds, args.repeat), ("dev", "", 12, 1))
        args = build_parser().parse_args(["--persona", "p.json", "--profile", "fake", "--user-model", "fake/fake-model"])
        self.assertEqual((args.profile, args.user_model), ("fake", "fake/fake-model"))
        self.assertEqual(profile_model("fake"), "fake/fake-model")
        self.assertIsNone(profile_model("没有这份配置"))
        persona = {"名字": "测试用户", "人设": "说话很短。", "目标": "拿到一份需求说明。", "材料": [], "隐藏事实": [], "接受底线": []}
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(user_agent_session(persona, Path(tmp)).profile["model"], load_profile()["model"])
            self.assertEqual(user_agent_session(persona, Path(tmp), None, "fake/fake-model").profile["model"], "fake/fake-model")

if __name__ == "__main__":
    unittest.main()
