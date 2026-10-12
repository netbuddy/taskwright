"""用户 agent 的系统提示：画像「熟悉的材料」在运行时读入全文，画像文件本身不带材料原文。"""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from sim import launch_user

REPO = Path(__file__).resolve().parents[2]
PERSONA = {"名字": "测试用户", "人设": "说话很短。", "目标": "拿到一份需求说明。", "材料": ["a.md", "b.md"], "熟悉的材料": ["a.md"],
           "材料说明": "一份需求。", "隐藏事实": [{"事实": "周末不算。", "关键词": ["周末"]}],
           "接受底线": [{"说法": "都要写到。", "判据": {}}]}


class SystemPromptTest(unittest.TestCase):
    def test_熟悉的材料全文放进系统提示_不熟悉的只列文件名(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "a.md").write_text("读者凭借书证借书。\n每本书可以续借一次。\n", encoding="utf-8")
            (Path(tmp) / "b.md").write_text("这一份扮演者没读过。", encoding="utf-8")
            prompt = launch_user.system_prompt(PERSONA, Path(tmp))
        self.assertIn("这份材料是你自己整理的，里面写了什么你清楚。", prompt)
        self.assertIn("#### 《a.md》\n\n~~~~text\n读者凭借书证借书。\n每本书可以续借一次。\n~~~~", prompt)
        self.assertNotIn("这一份扮演者没读过", prompt)
        self.assertIn("材料文件：《a.md》、《b.md》。", prompt)
        self.assertIn("不知道的事就说不知道", prompt)
        # 加的两句：接受底线只在看结果时用；选项里没有自己的做法就直接说。
        self.assertIn("「什么样的结果你才接受」是你看结果时用的", prompt)
        self.assertIn("一开口不要把这些要求先说出来", prompt)
        self.assertIn("不要点最接近的那个，直接用一句话说出你的做法", prompt)
        self.assertNotIn("周末", prompt.split("你心里知道")[0].split("## 你是谁")[0])

    def test_列了熟悉的材料却没给目录或文件不在_直接报错(self):
        with self.assertRaises(ValueError):
            launch_user.system_prompt(PERSONA)
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(FileNotFoundError):
            launch_user.system_prompt(PERSONA, Path(tmp))

    def test_基准画像文件里没有材料原文_判定用的字段不进系统提示(self):
        persona = json.loads((REPO / "sim" / "personas" / "librarian.json").read_text(encoding="utf-8"))
        self.assertEqual(persona["熟悉的材料"], ["requirements.md"])
        text = launch_user.persona_text(persona)
        for fact in persona["隐藏事实"]:
            self.assertNotIn("问到的迹象", text)
            self.assertIn(fact["事实"], text)
        self.assertNotIn("必须同时出现", text)
        self.assertNotIn("判据", text)

    @unittest.skipUnless(shutil.which("node"), "本机没有 node")
    def test_评测用的两份画像_材料在示例目录里_系统提示拼得出来_判定用的键不进提示(self):
        examples = REPO / "examples" / "library-lending"
        for name, material, opening in (("library-short.json", "requirements.md", "借书"),
                                        ("library-long.json", "requirements-styled.docx", "[p7] 我们学校图书馆")):
            persona = json.loads((REPO / "sim" / "personas" / name).read_text(encoding="utf-8"))
            self.assertEqual(persona["熟悉的材料"], [material])
            self.assertTrue(persona["答不上的说法"])
            prompt = launch_user.system_prompt(persona, examples)
            self.assertIn(f"#### 《{material}》", prompt)
            self.assertIn(opening, prompt)
            for fact in persona["隐藏事实"]:
                self.assertIn(fact["事实"], prompt)
            for key in ("问到的迹象", "必须同时出现", "判据", "答不上的说法"):
                self.assertNotIn(key, prompt)
            # 人设里的扮演规矩：逐页看主题、确认助手补的内容；助手提议进入下一段时看过点名的页就点进入，还有事没说完就先说。只留这一句，没有早先的那两句。
            self.assertIn("助手请你看几页主题时，你逐页打开看；页上有助手补的内容、你觉得对就点确认。助手提议进入下一段时，你先看它点名的页，觉得可以就点进入；"
                          "还有与这一段有关的事没说完，就先不点，直接把那件事说出来，说完了再点进入。", prompt)
            for gone in ("助手要你看主题页、点确认时，你照做", "『开始写条目』", "『继续澄清』"):
                self.assertNotIn(gone, prompt)
            # 系统提示里操作上的三句：主题页怎样看、怎样确认；提议进入下一段的卡片怎样应对（不写死是哪一张）；选项按文字点。
            self.assertIn("卡片上「涉及的条目」列出的页，你先照第 2、3 条逐个打开看过，再点进入下一段的那个选项。", prompt)
            self.assertIn("这时不点卡片，直接用一句话把那件事说出来；说完了，助手再提议时就点进入。", prompt)
            self.assertIn("一页后面写着「有几处是助手补的，等你确认」时，打开只是看；你看了觉得对，就再 look 一次这一页并把 confirm 设为 true，这才算确认", prompt)
            self.assertIn("卡片给了几个选项时，click 里写选项的文字", prompt)


if __name__ == "__main__":
    unittest.main()
