"""执行者的两层 skill：平台 skill（代码仓里，所有任务类型共用）与任务 skill（任务目录里，只写这类任务的做法）。

这里核对四件事：启动命令行里两个 --skill 的先后、平台 skill 文件本身合不合 pi 的要求、
任务 skill 里不再出现平台层的写法（防止通用规则流回任务 skill）、启动补记与知识摘要记下了平台 skill。
"""

from __future__ import annotations

import copy
import re
import tempfile
import unittest
from pathlib import Path

from taskwright_server import launch

PLATFORM_DIR = launch.REPO_ROOT / "agent" / "prompts" / "skills" / "taskwright-executor"
TASK_SKILLS = sorted((launch.REPO_ROOT / "task-types").glob("*/.pi/skills/*/SKILL.md"))

#: 平台层的词：工具名与回复工具、来源、版本号的参数名。它们只该出现在平台 skill 里。
PLATFORM_WORDS = ("reply", "base_version", "base_revision", "version_no", "revision_no", "supports", "complete_task", "informs", "act")

#: 已经退役的工具与角色：平台 skill 与任务 skill 里都不该再出现。登记用户确认工具与确认判读者在「已读即确认」时退役。
RETIRED_WORDS = ("record_confirmation", "登记用户确认", "判读者")


def frontmatter(text: str) -> tuple[dict[str, str], str]:
    """拆出 SKILL.md 开头两行 --- 之间的「名字: 值」与其后的正文。没有 frontmatter 时返回空字典与全文。"""
    match = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not match:
        return {}, text
    fields = {}
    for line in match.group(1).splitlines():
        name, sep, value = line.partition(":")
        if sep:
            fields[name.strip()] = value.strip()
    return fields, match.group(2)


def profile_with_stub_executable() -> dict:
    """开发用启动配置，只把可执行文件换成一定在 PATH 上的 python3：这里只看命令行怎么拼，不真启动 pi。"""
    profile = copy.deepcopy(launch.load_profile("dev"))
    profile["executable"] = "python3"
    profile["extensions"] = [e for e in profile["extensions"] if e.get("source") == "repo"]
    return profile


class CommandLineTest(unittest.TestCase):
    def test_两个skill参数且平台在前(self):
        with tempfile.TemporaryDirectory() as folder:
            workspace = Path(folder)
            (workspace / ".pi" / "skills" / "demo").mkdir(parents=True)
            argv, _ = launch.build_command(profile_with_stub_executable(), workspace, workspace / "sessions")
            at = [i for i, part in enumerate(argv) if part == "--skill"]
            self.assertEqual(len(at), 2, argv)
            self.assertEqual(argv[at[0] + 1], str(PLATFORM_DIR))
            self.assertEqual(argv[at[1] + 1], str((workspace / ".pi" / "skills").resolve()))

    def test_任务目录没有技能目录时只传平台skill(self):
        with tempfile.TemporaryDirectory() as folder:
            argv, _ = launch.build_command(profile_with_stub_executable(), Path(folder), Path(folder) / "sessions")
            self.assertEqual([argv[i + 1] for i, p in enumerate(argv) if p == "--skill"], [str(PLATFORM_DIR)])

    def test_配置写了平台skill但文件不在时报错(self):
        profile = profile_with_stub_executable()
        profile["platform_skill"] = "agent/prompts/skills/no-such-skill"
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(launch.LaunchError) as caught:
                launch.build_command(profile, Path(folder), Path(folder) / "sessions")
            self.assertIn("no-such-skill/SKILL.md", str(caught.exception))

    def test_配置没写平台skill时不传(self):
        profile = profile_with_stub_executable()
        profile.pop("platform_skill")
        with tempfile.TemporaryDirectory() as folder:
            argv, _ = launch.build_command(profile, Path(folder), Path(folder) / "sessions")
            self.assertNotIn("--skill", argv)
            self.assertFalse(launch.startup_record(profile, argv)["平台 skill"]["有没有"])


class PlatformSkillFileTest(unittest.TestCase):
    def test_文件存在且frontmatter合法(self):
        text = (PLATFORM_DIR / "SKILL.md").read_text(encoding="utf-8")
        fields, body = frontmatter(text)
        # pi 的要求：name 与所在目录同名，只用小写字母、数字与连字符，不超过 64 个字符；description 必填。
        self.assertEqual(fields.get("name"), PLATFORM_DIR.name)
        self.assertRegex(fields["name"], r"^[a-z0-9]+(-[a-z0-9]+)*$")
        self.assertLessEqual(len(fields["name"]), 64)
        self.assertTrue(fields.get("description"))
        self.assertTrue(body.strip())

    def test_平台skill只用修订号不用版本号(self):
        body = frontmatter((PLATFORM_DIR / "SKILL.md").read_text(encoding="utf-8"))[1]
        for word in ("version_no", "base_version", "版本号是", "新版本", "当前版本"):
            self.assertNotIn(word, body)
        self.assertIsNone(re.search(r"第 ?[0-9N一二三四五六七八九十]+ ?版", body))
        self.assertIn("base_revision", body)
        self.assertIn("revision_no", body)

    def test_平台skill不写需求规格任务的专名(self):
        body = frontmatter((PLATFORM_DIR / "SKILL.md").read_text(encoding="utf-8"))[1]
        # 需求规格任务的问题集合现在叫「问题」，这是个日常词，平台 skill 也用它说问题条目，所以只拦旧名。
        for word in ("功能用例", "非功能需求", "待定与范围外事项", "UC-", "NFR-", "CON-", "TBD-", "srs-authoring",
                     "use-case-writing", "ears-writing", "基本流程", "前置条件"):
            self.assertNotIn(word, body)

    def test_平台skill写明被拒后不删信息换通过(self):
        body = frontmatter((PLATFORM_DIR / "SKILL.md").read_text(encoding="utf-8"))[1]
        self.assertIn("不得为了通过而删掉引用、来源或关联条目", body)
        self.assertIn("删掉信息换取通过是错误做法", body)

    def test_平台skill有评审一节_评审由用户发起_工具只在用户要求时用(self):
        body = frontmatter((PLATFORM_DIR / "SKILL.md").read_text(encoding="utf-8"))[1]
        self.assertIn("## 六、评审", body)
        for words in ("评审由用户在界面上发起，你不要主动评审", "用户在对话里要求评审时，才调用请求评审（request_review）",
                      "问题类发现照建议改", "建议类发现告诉用户，由用户定", "不得为通过评审删掉内容或来源"):
            self.assertIn(words, body)

    def test_执行者工具白名单是十个_含请求评审与自带的检索工具_扩展里登记了请求评审(self):
        tools = launch.load_profile("dev")["tools"]
        self.assertEqual(len(tools), 10, tools)
        self.assertIn("request_review", tools)
        self.assertTrue({"grep", "find"} <= set(tools), tools)
        extension = (launch.REPO_ROOT / "agent" / "src" / "extension.ts").read_text(encoding="utf-8")
        self.assertIn("registerRequestReview(pi);", extension)
        self.assertNotIn("开发期开关", launch.load_profile("dev"), "评审门禁做出来之后开发期开关退役")

    def test_同批引用_平台skill写明可以引用排在前面的新增条目_任务skill仍把问题条目放最后一批(self):
        platform = frontmatter((PLATFORM_DIR / "SKILL.md").read_text(encoding="utf-8"))[1]
        self.assertIn("问题条目的关联条目只能填已经存在的条目，或者同一批里排在它前面新增的条目", platform)
        self.assertIn("也可以写同一批里排在前面的新增操作将要拿到的编号", platform)
        for path in [PLATFORM_DIR / "SKILL.md", *TASK_SKILLS]:
            body = frontmatter(path.read_text(encoding="utf-8"))[1]
            # 保存修订已经认同一批里排在前面的新增条目，这句旧说法与工具行为相反，不能再出现。
            self.assertNotIn("同一批里新增的条目还没有编号", body, str(path.relative_to(launch.REPO_ROOT)))
        for path in TASK_SKILLS:
            body = frontmatter(path.read_text(encoding="utf-8"))[1]
            self.assertIn("再把问题条目单独放在最后一批保存，不和别的条目放在同一批：每批内容少，出错时好改。", body,
                          str(path.relative_to(launch.REPO_ROOT)))


class TaskSkillGuardTest(unittest.TestCase):
    def test_至少有一份任务skill(self):
        self.assertTrue(TASK_SKILLS)

    def test_任务skill正文不含平台层的词(self):
        for path in TASK_SKILLS:
            body = frontmatter(path.read_text(encoding="utf-8"))[1]
            for word in PLATFORM_WORDS:
                # 前后都不是英文字母或下划线才算这个词，免得 act 误中 action、contract 之类。
                found = re.search(rf"(?<![A-Za-z_]){re.escape(word)}(?![A-Za-z_])", body)
                self.assertIsNone(found, f"{path.relative_to(launch.REPO_ROOT)} 里出现了平台层的词 {word}")

    def test_两层skill都不提已退役的工具与角色(self):
        for path in [PLATFORM_DIR / "SKILL.md", *TASK_SKILLS]:
            text = path.read_text(encoding="utf-8")
            for word in RETIRED_WORDS:
                self.assertNotIn(word, text, f"{path.relative_to(launch.REPO_ROOT)} 里还提到已退役的 {word}")

    def test_任务skill指向平台skill(self):
        for path in TASK_SKILLS:
            self.assertIn("taskwright-executor", path.read_text(encoding="utf-8"))

    def test_需求规格任务skill用新的集合名问题(self):
        body = (launch.REPO_ROOT / "task-types" / "srs-authoring" / ".pi" / "skills" / "srs-authoring" / "SKILL.md").read_text(encoding="utf-8")
        self.assertNotIn("待定与范围外事项", body)
        self.assertNotIn("待定事项", body)
        self.assertIn("「问题」集合里的条目叫问题条目，编号前缀是 TBD", body)


class SystemPromptTest(unittest.TestCase):
    def test_系统提示先读平台skill且不提领域(self):
        profile = launch.load_profile("dev")
        text = (launch.REPO_ROOT / profile["system_prompt_file"]).read_text(encoding="utf-8")
        self.assertTrue(text.startswith("你是 Taskwright 的执行者"))
        self.assertIn("先用 read 读 taskwright-executor 的正文，再读任务 skill 的正文", text)
        self.assertNotIn("需求工程", text)


class LaunchNoteTest(unittest.TestCase):
    def test_启动补记记下平台skill的路径与摘要值(self):
        profile = profile_with_stub_executable()
        with tempfile.TemporaryDirectory() as folder:
            argv, _ = launch.build_command(profile, Path(folder), Path(folder) / "sessions")
        record = launch.startup_record(profile, argv)["平台 skill"]
        self.assertTrue(record["有没有"])
        self.assertEqual(record["代码仓里的路径"], "agent/prompts/skills/taskwright-executor")
        self.assertEqual([f["路径"] for f in record["文件"]], ["SKILL.md"])
        self.assertEqual(len(record["文件"][0]["摘要值"]), 16)

    def test_知识摘要带上平台skill(self):
        profile = profile_with_stub_executable()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "docs").mkdir()
            (root / "docs" / "a.md").write_text("a", encoding="utf-8")
            snap = launch.knowledge_snapshot(root, profile)
            platform = [f for f in snap["文件"] if f.get("来自") == "平台 skill"]
            self.assertEqual([f["路径"] for f in platform], [str(PLATFORM_DIR / "SKILL.md")])
            self.assertEqual(platform[0]["代码仓里的路径"], "agent/prompts/skills/taskwright-executor/SKILL.md")
            self.assertIn("docs/a.md", [f["路径"] for f in snap["文件"]])
            # 不给启动配置时与以前一样，只记任务目录。
            self.assertEqual([f["路径"] for f in launch.knowledge_snapshot(root)["文件"]], ["docs/a.md"])


if __name__ == "__main__":
    unittest.main()
