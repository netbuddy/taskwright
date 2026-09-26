"""启动配置里「材料分段」一节：两份配置都写了三个参数与各自的说明，读取时缺项用默认值、写错时报清楚，
参数经环境变量交给 pi 里的扩展；默认值与 agent 侧 lib/segments.ts 的 SEGMENT_DEFAULTS 相同。"""

from __future__ import annotations

import json
import re
import unittest

from taskwright_server import launch

SEGMENTS_TS = launch.REPO_ROOT / "agent" / "src" / "lib" / "segments.ts"


class SegmentParamsTest(unittest.TestCase):
    def test_both_profiles_write_all_three_with_notes(self):
        for name in ("dev", "fake"):
            profile = launch.load_profile(name)
            section = profile["材料分段"]
            self.assertEqual({k: section[k] for k in launch.SEGMENT_DEFAULTS}, launch.SEGMENT_DEFAULTS, name)
            for note in ("说明", "标题级别说明", "段数上限说明", "段数下限说明"):
                self.assertTrue(section.get(note), f"{name} 缺 {note}")
            self.assertIn("grep", profile["tools"])
            self.assertIn("find", profile["tools"])

    def test_defaults_match_agent_side(self):
        text = SEGMENTS_TS.read_text(encoding="utf-8")
        found = re.search(r"SEGMENT_DEFAULTS[^=]*= Object\.freeze\((\{[^}]*\})\)", text)
        self.assertIsNotNone(found)
        agent_side = json.loads(re.sub(r"(\w+):", r'"\1":', found.group(1)))
        self.assertEqual(agent_side, launch.SEGMENT_DEFAULTS)

    def test_missing_items_fall_back_and_bad_values_are_refused(self):
        self.assertEqual(launch.segment_params({}), launch.SEGMENT_DEFAULTS)
        self.assertEqual(launch.segment_params({"材料分段": {"max_paragraphs": 120}}),
                         {**launch.SEGMENT_DEFAULTS, "max_paragraphs": 120})
        for bad in (0, -1, 2.5, "3", True):
            with self.assertRaises(launch.LaunchError) as caught:
                launch.segment_params({"材料分段": {"heading_depth": bad}})
            self.assertIn("heading_depth 应当是正整数", str(caught.exception))

    def test_environment_carries_the_params(self):
        env = launch.build_environment({"材料分段": {"min_paragraphs": 1}})
        self.assertEqual(json.loads(env[launch.ENV_SEGMENTS]), {**launch.SEGMENT_DEFAULTS, "min_paragraphs": 1})
        self.assertEqual(env[launch.ENV_SEGMENTS], '{"heading_depth":3,"max_paragraphs":300,"min_paragraphs":1}')


if __name__ == "__main__":
    unittest.main()
