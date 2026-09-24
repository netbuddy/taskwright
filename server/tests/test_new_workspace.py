"""建任务目录：起始文件原样复制；起始文件目录没带 pi 的项目设置时，写一份排队模式为 all 的。"""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from taskwright_server import new_workspace


class NewWorkspaceTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="taskwright-new-dir-"))
        self.source = self.root / "start"
        (self.source / "docs").mkdir(parents=True)
        (self.source / "docs" / "a.md").write_text("甲", encoding="utf-8")
        (self.source / "README.md").write_text("给人看的", encoding="utf-8")

    def make(self, name):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            path = new_workspace.create(self.root / name, self.source)
        return path, out.getvalue()

    def test_writes_follow_up_mode_when_missing(self):
        path, out = self.make("ws1")
        self.assertEqual(json.loads((path / ".pi" / "settings.json").read_text(encoding="utf-8")), {"followUpMode": "all"})
        self.assertIn("已写一份", out)
        self.assertFalse((path / "README.md").exists())
        self.assertTrue((path / "inputs").is_dir())

    def test_keeps_settings_from_start_files(self):
        (self.source / ".pi").mkdir()
        (self.source / ".pi" / "settings.json").write_text('{"followUpMode": "all", "x": 1}', encoding="utf-8")
        path, out = self.make("ws2")
        self.assertEqual(json.loads((path / ".pi" / "settings.json").read_text(encoding="utf-8")), {"followUpMode": "all", "x": 1})
        self.assertNotIn("已写一份", out)


if __name__ == "__main__":
    unittest.main()
