"""桌面包的启动配置 desktop.json：Python 版能读它，除说明与 Langfuse 环境标签以外与 dev 相同，Langfuse 插件是非必需的。"""

from __future__ import annotations

import unittest

from taskwright_server import launch


class DesktopProfileTest(unittest.TestCase):
    def test_能读_除说明与环境标签外与dev相同(self):
        dev = launch.load_profile("dev")
        desktop = launch.load_profile("desktop")
        self.assertEqual(desktop["langfuse"], {"environment": "desktop"})
        self.assertIn("桌面包", desktop["说明"])
        strip = lambda p: {k: v for k, v in p.items() if k not in ("说明", "langfuse")}
        self.assertEqual(strip(desktop), strip(dev), "改 dev 时要同步改 desktop")

    def test_Langfuse插件非必需_没有设环境变量时照样拼得出命令行(self):
        desktop = launch.load_profile("desktop")
        plugins = [e for e in desktop["extensions"] if e.get("source") == "env"]
        self.assertTrue(plugins)
        self.assertTrue(all(e.get("required") is False for e in plugins))


if __name__ == "__main__":
    unittest.main()
