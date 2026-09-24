"""只读查看任务目录里的任务数据库 task.sqlite。

这台机器上没有 sqlite3 命令行程序，所以用这个小工具查库。它只读不写：连接是以只读方式
打开的，代码里也没有任何写语句。

新格式的库（按条目记版本，由「创建任务」与「保存修订」工具写）按五段打印：任务、各集合的条目
（当前版本的各字段）、每个条目的版本历史与来源、修订列表、事件列表。旧格式的库（有 slot 表）
仍按原来的样子打印。库文件不存在时打印「这个任务目录还没有创建任务」并正常退出。

用法：

    python -m taskwright_observatory.dbshow <任务目录>                看全部五段（新格式）或任务、字段、事件（旧格式）
    python -m taskwright_observatory.dbshow <任务目录> --events 30    多看几条事件
    python -m taskwright_observatory.dbshow <任务目录> --history 释义草稿   旧格式：看某个字段的版本历史
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from taskwright_observatory import taskdb

DB_NAME = "task.sqlite"

#: 值太长时截断到这么多字，全文用 --history 看。
VALUE_LIMIT = 200


def connect(workspace: Path) -> sqlite3.Connection:
    """以只读方式打开任务目录里的库。库不在就报错，不新建。"""
    path = Path(workspace).expanduser().resolve() / DB_NAME
    if not path.is_file():
        raise SystemExit(f"{path} 不存在。先用 python -m taskwright_server.new_workspace 建一个任务目录。")
    # 与 taskdb 用同一个只读打开函数：同样的忙等待超时，同样处理 WAL 模式下目录不可写的情形。
    return taskdb.open_readonly(path)


def shorten(text: str) -> str:
    if text is None:
        return "（空）"
    value = json.loads(text)
    if value is None:
        return "（空）"
    shown = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if len(shown) <= VALUE_LIMIT:
        return shown
    return shown[:VALUE_LIMIT] + f"……（共 {len(shown)} 字）"


def show_task(conn: sqlite3.Connection) -> None:
    rows = conn.execute("SELECT id, def_name, status, started_at FROM task ORDER BY rowid").fetchall()
    if not rows:
        print("这个库里还没有任务。")
        return
    print("【任务】")
    for row in rows:
        print(f"  {row['id']}（{row['def_name']}），状态是{row['status']}，开始于 {row['started_at']}")


def show_slots(conn: sqlite3.Connection) -> None:
    rows = conn.execute("SELECT name, type, value, version, source, updated_at FROM slot ORDER BY rowid").fetchall()
    print("\n【各字段的当前值】")
    for row in rows:
        print(f"  {row['name']}（{row['type']}）：第 {row['version']} 版，写入者是{row['source']}，"
              f"改于 {row['updated_at']}")
        print(f"      {shorten(row['value'])}")


def show_events(conn: sqlite3.Connection, limit: int) -> None:
    rows = conn.execute(
        "SELECT seq, at, call_id, name, actor, source FROM event ORDER BY seq DESC LIMIT ?", (limit,)
    ).fetchall()
    print(f"\n【最近 {len(rows)} 条事件】（新的在上面）")
    print("  序号  时刻                      调用编号                            事件名             发起方  来源")
    for row in rows:
        call = row["call_id"] if row["call_id"] is not None else "（空）"
        print(f"  {row['seq']:>4}  {row['at']:<24}  {str(call):<34}  {row['name']:<18}  "
              f"{row['actor']:<6}  {row['source']}")


def show_history(conn: sqlite3.Connection, field: str) -> None:
    rows = conn.execute(
        "SELECT id, version, source, at, event_seq, new FROM slot_history WHERE name = ? ORDER BY id", (field,)
    ).fetchall()
    if not rows:
        names = "、".join(r["name"] for r in conn.execute("SELECT name FROM slot ORDER BY rowid"))
        print(f"字段「{field}」没有历史。这个库里的字段有：{names}。")
        return
    print(f"\n【字段「{field}」的版本历史】")
    for row in rows:
        print(f"  第 {row['version']} 版，写入者是{row['source']}，改于 {row['at']}，"
              f"挂在第 {row['event_seq']} 号事件上")
        print(f"      {shorten(row['new'])}")


def text_of(value, field_type: str = "") -> str:
    """把一个字段值写成一行文字：条目引用用顿号连起各个编号，文本列表逐项编号，其余原样。"""
    if field_type == "条目引用":
        return "、".join(value) if isinstance(value, list) else str(value)
    if isinstance(value, list):
        return "；".join(f"{i}. {one}" for i, one in enumerate(value, 1))
    return str(value)


def clip(text: str) -> str:
    return text if len(text) <= VALUE_LIMIT else text[:VALUE_LIMIT] + f"……（共 {len(text)} 字）"


def show_judgements(workspace: Path) -> None:
    """确认判读与模型调用：每次判读的依据与明细，以及判读者每次模型调用的结果、耗时与用量。
    提示全文与原始输出很长，这里只给长度；要看全文用观测台，或直接查 model_call 表。"""
    conn = taskdb.open_readonly(Path(workspace) / taskdb.DB_NAME)
    try:
        judgements = [dict(r) for r in conn.execute("SELECT * FROM judgement ORDER BY judgement_id")]
        details = [dict(r) for r in conn.execute("SELECT * FROM judgement_item ORDER BY judgement_id, item_id")]
        has_calls = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_call'").fetchone()
        calls = [dict(r) for r in conn.execute("SELECT * FROM model_call ORDER BY model_call_id")] if has_calls else []
    finally:
        conn.close()
    print("\n【确认判读】")
    if not judgements:
        print("  还没有任何确认记录。")
    for j in judgements:
        rows = [f"{d['item_id']} 第 {d['version_no']} 版{d['attitude']}" for d in details if d["judgement_id"] == j["judgement_id"]]
        print(f"  第 {j['judgement_id']} 次判读，{j['created_at']}，事件序号 {j['event_seq']}，调用编号 {j['call_id']}：{'；'.join(rows)}")
        print(f"    依据 {clip(j['basis'])}")
    print("\n【模型调用】" + ("" if has_calls else "（这个库建于加模型调用表之前，没有这张表）"))
    if has_calls and not calls:
        print("  还没有任何模型调用。")
    for c in calls:
        linked = f"判读 {c['judgement_id']}" if c["judgement_id"] is not None else "没有写成判读"
        print(f"  #{c['model_call_id']} {c['role']}，{c['outcome']}（{linked}），{c['model']}，{c['duration_ms']} 毫秒，"
              f"用量 {c['input_tokens']} / {c['output_tokens']}，工具调用 {c['tool_call_id']}，{c['created_at']}；"
              f"提示 {len(c['prompt'])} 字，输出 {len(c['output'])} 字：{clip(c['output'])}")


def show_current_format(workspace: Path, events_limit: int) -> None:
    data = taskdb.read_workspace(workspace)
    for task in data["任务"]:
        definition = task["任务定义"]
        print("【任务】")
        print(f"  {task['任务编号']}「{task['任务名']}」（类型：{task.get('任务类型') or task['任务名']}），状态是{task['状态']}，"
              f"开始于 {task['开始时刻']}" + (f"，结束于 {task['结束时刻']}" if task["结束时刻"] else "")
              + f"；领域标签{('是 ' + task['领域标签']) if task.get('领域标签') else '没有填'}。")
        session = task['创建它的会话编号'] or "空（由用户在界面上创建，那时还没有会话）"
        print(f"  任务定义文件是 {task['任务定义文件']}；创建它的会话编号是 {session}，"
              f"调用编号是 {task['创建它的调用编号']}，事件序号是 {task['创建的事件序号']}。")

        print("\n【各集合的条目（当前版本）】")
        for collection in definition["集合"]:
            alive = [i for i in task["条目"] if i["所属集合"] == collection["名称"] and i["在第几次修订删除"] is None]
            gone = [i for i in task["条目"] if i["所属集合"] == collection["名称"] and i["在第几次修订删除"] is not None]
            print(f"  ▸ 集合「{collection['名称']}」：现有 {len(alive)} 个条目"
                  + (f"，另有 {len(gone)} 个已删除" if gone else "") + "。")
            for item in alive:
                current = item["当前版本"]
                print(f"    {item['条目编号']}（第 {current['内容版本号']} 版）")
                for field in collection["字段"]:
                    if field["名"] in current["字段"]:
                        print(f"      {field['名']}：{clip(text_of(current['字段'][field['名']], field['类型']))}")

        print("\n【每个条目的版本历史与来源】")
        for item in task["条目"]:
            tail = (f"，在第 {item['在第几次修订删除']} 次修订删除" if item["在第几次修订删除"] is not None else "")
            print(f"  {item['条目编号']}（集合「{item['所属集合']}」），在第 {item['在第几次修订新增']} 次修订新增{tail}，"
                  f"一共 {len(item['版本'])} 版。")
            for version in item["版本"]:
                print(f"    第 {version['内容版本号']} 版：由第 {version['由第几次修订产生']} 次修订产生，"
                      f"挂在第 {version['事件序号']} 号事件上，来源 {len(version['来源'])} 条。")
                for source in version["来源"]:
                    print(f"      来源 {source['第几条']}：种类是{source['种类']}，出处是 {source['出处']}，"
                          f"支持{taskdb.support_text(source.get('支持') or [])}，摘录是「{clip(source['摘录'])}」")

        print("\n【修订列表】")
        if not task["修订"]:
            print("  还没有任何一次修订。")
        for revision in task["修订"]:
            ops = "；".join(
                f"{ {'add': '新增', 'update': '修改', 'delete': '删除'}.get(op.get('op'), op.get('op'))} {op.get('item')}"
                + (f"（第 {op.get('from_version')} 版到第 {op.get('to_version')} 版）" if op.get("op") == "update" else "")
                for op in revision["操作"])
            print(f"  第 {revision['修订序号']} 次修订，{revision['时刻']}，事件序号 {revision['事件序号']}，"
                  f"调用编号 {revision['调用编号']}：{ops}")

        show_judgements(workspace)

        events = task["事件"][-events_limit:]
        print(f"\n【事件列表】（最近 {len(events)} 条，旧的在上面）")
        print("  序号  时刻                      事件名           发起方  调用编号")
        for event in events:
            print(f"  {event['事件序号']:>4}  {event['时刻']:<24}  {event['事件名']:<15}  "
                  f"{event['发起方']:<6}  {event['调用编号']}")
            print(f"        会话编号 {event['会话编号']}；内容 {clip(json.dumps(event['内容'], ensure_ascii=False))}")
        print()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="只读查看任务目录里的任务数据库。")
    parser.add_argument("workspace", help="任务目录，里面应当有 task.sqlite")
    parser.add_argument("--events", type=int, default=10, help="最近多少条事件，默认 10 条")
    parser.add_argument("--history", metavar="字段名", help="旧格式的库：看这个字段的版本历史")
    args = parser.parse_args(argv)
    workspace = Path(args.workspace).expanduser().resolve()
    fmt = taskdb.format_of_workspace(workspace)
    if fmt in (taskdb.FORMAT_MISSING, taskdb.FORMAT_EMPTY):
        print(f"{taskdb.NO_TASK_YET}：{workspace / DB_NAME} "
              + ("不存在。" if fmt == taskdb.FORMAT_MISSING else "里一张表都没有。"))
        return 0
    if fmt == taskdb.FORMAT_CURRENT:
        show_current_format(workspace, args.events)
        return 0
    if fmt == taskdb.FORMAT_UNKNOWN:
        print(f"{workspace / DB_NAME} 里的表既不是旧格式也不是新格式，这个工具认不出来。")
        return 1
    conn = connect(workspace)
    show_task(conn)
    show_slots(conn)
    show_events(conn, args.events)
    if args.history:
        show_history(conn, args.history)
    return 0


if __name__ == "__main__":
    sys.exit(main())
