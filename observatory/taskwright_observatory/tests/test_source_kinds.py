"""读来源时种类名一律换成现在的：早期版本建的库（没有迁过）与迁过的库读出来一样。"""

import sqlite3
import unittest

from taskwright_observatory import taskdb

OLD_TABLE = """CREATE TABLE item_source (task_id TEXT, item_id TEXT, revision_no INTEGER, position INTEGER, support_no INTEGER,
  kind TEXT, locator TEXT, excerpt TEXT, field TEXT, field_index INTEGER, event_seq INTEGER, normalized_value TEXT)"""
NEW_TABLE = OLD_TABLE[:-1] + ", element_kind TEXT DEFAULT '条目', depends_revision INTEGER)"


def database(table: str, rows: list[tuple]) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(table)
    conn.execute("CREATE TABLE item_version (task_id TEXT, item_id TEXT, revision_no INTEGER)")
    # DN-001 在修订 1 新增、修订 3 修改。
    conn.executemany("INSERT INTO item_version VALUES ('T', ?, ?)", [("DN-001", 1), ("DN-001", 3), ("UC-001", 2), ("UC-002", 4)])
    marks = ", ".join("?" for _ in rows[0])
    conn.executemany(f"INSERT INTO item_source VALUES ({marks})", rows)
    return conn


class SourceKinds(unittest.TestCase):
    def test_早期版本的库_种类与出处读成现在的名字_依据的修订现算(self):
        conn = database(OLD_TABLE, [
            ("T", "UC-001", 2, 1, 1, "执行者补充", "执行者补充", "按常识补的", None, None, 5, None),
            ("T", "UC-001", 2, 2, 1, "领域说明", "DN-001", "口令", "名称", None, 5, None),
            ("T", "UC-002", 4, 1, 1, "领域说明", "DN-001", "口令", None, None, 9, None),
            ("T", "UC-002", 4, 2, 1, "文档原文", "inputs/a.md", "原话", None, None, 9, None),
        ])
        sources = taskdb.read_sources(conn, "T")
        self.assertEqual([(s["种类"], s["出处"], s.get("依据的修订")) for s in sources[("UC-001", 2)]],
                         [("助手补充", "助手补充", None), ("条目", "DN-001", 1)])
        self.assertEqual([(s["种类"], s["出处"], s.get("依据的修订")) for s in sources[("UC-002", 4)]],
                         [("条目", "DN-001", 3), ("文档原文", "inputs/a.md", None)])
        self.assertNotIn("依据的修订", sources[("UC-002", 4)][1])

    def test_迁过的库_依据的修订取库里记下的(self):
        conn = database(NEW_TABLE, [
            ("T", "UC-002", 4, 1, 1, "条目", "DN-001", "口令", None, None, 9, None, "条目", 1),
            ("T", "UC-002", 4, 2, 1, "助手补充", "助手补充", "理由", None, None, 9, None, "条目", None),
        ])
        sources = taskdb.read_sources(conn, "T")[("UC-002", 4)]
        self.assertEqual([(s["种类"], s["出处"], s.get("依据的修订")) for s in sources], [("条目", "DN-001", 1), ("助手补充", "助手补充", None)])


if __name__ == "__main__":
    unittest.main()
