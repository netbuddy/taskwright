"""只读的不变式核对：核对新格式任务数据库里的记录互相对得上。

用法：

    python -m taskwright_observatory.check_db <任务目录>

核对下面几项，逐项打印通过或不通过，不通过的给出是哪一行：

1. 每次修订至少对应一处条目变化（新增、修改或删除了至少一个条目）。
2. 每一行条目内容都指向存在的条目与修订，同一条目在同一次修订下至多一行内容；每一行来源都指向存在的
   （条目、修订）内容行。条目没有单独的版本号，条目在某一时刻的内容由「条目编号加修订号」标识。
3. 条目编号在任务内不重复，并且与所属集合的编号前缀、流水号相符。
4. 每一处写入都找得到同一个调用编号或操作编号的事件：任务、修订、条目、条目内容、来源各行记的事件序号
   都指向存在的事件，而且那条事件的调用编号与这次写入的调用编号相同。执行者经工具的写入，这个编号是
   pi 的调用编号；用户在界面上的直接操作经扩展命令写入，这个编号是后端生成的操作编号（以 ui- 开头）。
5. 同一时刻至多一个进行中的任务。
6. 事件序号从 1 起连续。
7. 修订事件里记的每个操作都与条目内容表对得上：改后所在的修订就是这次修订、那一行存在；改前所在的修订那一行也存在。
8. 发起方与编号相符：发起方只能是执行者（executor）或用户（user）；用户的写入，编号以 ui- 开头；
   执行者的写入，编号不以 ui- 开头。最早格式的库里执行者记作「模型」，当作执行者的旧写法认。
9. 每条确认标记都说得出依据：依据是「已读」（打开详情或卡片上点「这几条都看过了」）、「界面修改」（改字段与标为先不管时随修订自动写）
   或「界面点击」（撤回确认，早期版本还有点了确认的）之一；都不是的，是早期版本由模型读用户原话登记的确认，模型调用表里要有一行
   采用了的调用指向它。加模型调用表之前建的库没有这张表时，这一项只看有没有需要它的标记。
10. 评审与确认是挂在「条目加修订」上的标记：每条评审记录、每条确认标记都指向存在的（条目、修订）内容行。

这是事后查账，不是门禁：它只读不写，也不替写入工具做核对，写入时的核对在 pi 进程里的工具里。
全部通过时退出码是 0，有不通过的是 1。库文件不存在时说明「这个任务目录还没有创建任务」并以 0 退出。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from taskwright_observatory import taskdb

#: 发起方的取值，与 agent/src/lib/db.ts 的 ACTOR_EXECUTOR、ACTOR_USER、LEGACY_ACTOR_MODEL 一致。
ACTOR_EXECUTOR = "executor"
#: 界面上的确认在判读依据里的写法，与 agent/src/lib/user_ops.ts 的 UI_CONFIRMATION_BASIS 一致：点了确认、改字段或标为先不管时随修订自动确认。
UI_BASES = ("已读", "界面点击", "界面修改")
ACTOR_USER = "user"
LEGACY_ACTOR_MODEL = "模型"
#: 后端给用户的直接操作生成的操作编号的前缀，例如 ui-op-13。
USER_OPERATION_PREFIX = "ui-"


def check(workspace: Path) -> list[dict]:
    """跑全部核对，返回每一项的结果：名目、通过与否、不通过的那几行。"""
    conn = taskdb.open_readonly(Path(workspace) / taskdb.DB_NAME)
    try:
        rows = {name: [dict(r) for r in conn.execute(f"SELECT * FROM {name}")]
                for name in ("task", "revision", "item", "item_version", "item_source", "event", "judgement", "judgement_item", "review")}
        has_model_call = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_call'").fetchone() is not None
        rows["model_call"] = [dict(r) for r in conn.execute("SELECT * FROM model_call")] if has_model_call else []
    finally:
        conn.close()
    # 一条来源支持几处字段就展开成几行，核对只看每条来源一次。
    unique_sources = {}
    for one in rows["item_source"]:
        unique_sources.setdefault((one["task_id"], one["item_id"], one["revision_no"], one["position"]), one)
    rows["item_source"] = list(unique_sources.values())
    events = {e["seq"]: e for e in rows["event"]}
    revisions = {(r["task_id"], r["revision_no"]): r for r in rows["revision"]}
    items = {(i["task_id"], i["item_id"]): i for i in rows["item"]}
    contents = {(v["task_id"], v["item_id"], v["revision_no"]): v for v in rows["item_version"]}
    prefixes = {}
    for task in rows["task"]:
        definition = taskdb.parse_definition(task["definition_text"])
        for collection in definition["集合"]:
            prefixes[(task["task_id"], collection["名称"])] = collection["编号前缀"]
    results = []

    def result(name: str, bad: list[str]) -> None:
        results.append({"名目": name, "通过": not bad, "不通过的行": bad})

    # 1
    bad = []
    for (task_id, no), revision in revisions.items():
        changes = sum(1 for v in rows["item_version"] if v["task_id"] == task_id and v["revision_no"] == no)
        changes += sum(1 for i in rows["item"] if i["task_id"] == task_id and i["deleted_in_revision"] == no)
        if changes == 0:
            bad.append(f"任务 {task_id} 的修订 {no} 没有对应任何条目变化。")
    result("每次修订至少对应一处条目变化", bad)

    # 2
    bad = []
    seen_content = set()
    for v in rows["item_version"]:
        key = (v["task_id"], v["item_id"], v["revision_no"])
        if key in seen_content:
            bad.append(f"条目 {v['item_id']} 在修订 {v['revision_no']} 下有不止一行内容。")
        seen_content.add(key)
        if (v["task_id"], v["item_id"]) not in items:
            bad.append(f"条目 {v['item_id']} 在修订 {v['revision_no']} 下的内容指向的条目不存在。")
        if (v["task_id"], v["revision_no"]) not in revisions:
            bad.append(f"条目 {v['item_id']} 的内容指向的修订 {v['revision_no']} 不存在。")
    for s in rows["item_source"]:
        if (s["task_id"], s["item_id"], s["revision_no"]) not in contents:
            bad.append(f"来源（{s['item_id']} 在修订 {s['revision_no']} 下的第 {s['position']} 条）指向的内容行不存在。")
    for i in rows["item"]:
        if (i["task_id"], i["added_in_revision"]) not in revisions:
            bad.append(f"条目 {i['item_id']} 记的新增修订（修订 {i['added_in_revision']}）不存在。")
        if i["deleted_in_revision"] is not None and (i["task_id"], i["deleted_in_revision"]) not in revisions:
            bad.append(f"条目 {i['item_id']} 记的删除修订（修订 {i['deleted_in_revision']}）不存在。")
        if not any(key[0] == i["task_id"] and key[1] == i["item_id"] for key in contents):
            bad.append(f"条目 {i['item_id']} 在任何修订下都没有内容。")
    result("每一行条目内容、来源都指向存在的条目与修订，同一条目同一修订至多一行", bad)

    # 3
    bad = []
    seen = set()
    for i in rows["item"]:
        key = (i["task_id"], i["item_id"])
        if key in seen:
            bad.append(f"任务 {i['task_id']} 里条目编号 {i['item_id']} 重复。")
        seen.add(key)
        prefix = prefixes.get((i["task_id"], i["collection"]))
        if prefix is None:
            bad.append(f"条目 {i['item_id']} 所属的集合「{i['collection']}」不在任务定义里。")
            continue
        match = re.fullmatch(rf"{re.escape(prefix)}-(\d{{3,}})", i["item_id"])
        if not match or int(match.group(1)) != i["serial"]:
            bad.append(f"条目 {i['item_id']} 与集合「{i['collection']}」的前缀 {prefix} 或它的流水号 {i['serial']} 对不上。")
    result("条目编号在任务内不重复且与集合的前缀相符", bad)

    # 4
    bad = []

    def expect(where: str, seq, call_id: str | None, task_id: str) -> None:
        event = events.get(seq)
        if event is None:
            bad.append(f"{where}记的事件序号 {seq} 找不到对应的事件。")
            return
        if event["task_id"] != task_id:
            bad.append(f"{where}记的第 {seq} 号事件属于任务 {event['task_id']}，不是 {task_id}。")
        if call_id is not None and event["call_id"] != call_id:
            bad.append(f"{where}的调用编号是 {call_id}，它记的第 {seq} 号事件的调用编号却是 {event['call_id']}。")

    for t in rows["task"]:
        expect(f"任务 {t['task_id']} ", t["event_seq"], t["call_id"], t["task_id"])
    for r in rows["revision"]:
        expect(f"任务 {r['task_id']} 的修订 {r['revision_no']}", r["event_seq"], r["call_id"], r["task_id"])
    for v in rows["item_version"]:
        call = (revisions.get((v["task_id"], v["revision_no"])) or {}).get("call_id")
        expect(f"条目 {v['item_id']} 在修订 {v['revision_no']} 下的内容", v["event_seq"], call, v["task_id"])
    for s in rows["item_source"]:
        call = (revisions.get((s["task_id"], s["revision_no"])) or {}).get("call_id")
        expect(f"来源（{s['item_id']} 在修订 {s['revision_no']} 下的第 {s['position']} 条）", s["event_seq"], call, s["task_id"])
    for i in rows["item"]:
        call = (revisions.get((i["task_id"], i["added_in_revision"])) or {}).get("call_id")
        expect(f"条目 {i['item_id']} 的新增", i["event_seq"], call, i["task_id"])
        if i["deleted_in_revision"] is not None:
            call = (revisions.get((i["task_id"], i["deleted_in_revision"])) or {}).get("call_id")
            expect(f"条目 {i['item_id']} 的删除", i["deleted_event_seq"], call, i["task_id"])
    result("每一处写入都找得到同一个调用编号或操作编号的事件", bad)

    # 5
    active = [t["task_id"] for t in rows["task"] if t["status"] == "进行中"]
    result("同一时刻至多一个进行中的任务",
           [] if len(active) <= 1 else [f"有 {len(active)} 个进行中的任务：{'、'.join(active)}。"])

    # 6
    seqs = sorted(events)
    result("事件序号连续",
           [] if seqs == list(range(1, len(seqs) + 1))
           else [f"事件序号应当是 1 到 {len(seqs)}，实际是 {seqs}。"])

    # 7
    bad = []
    for r in rows["revision"]:
        event = events.get(r["event_seq"]) or {}
        payload = taskdb._json(event.get("payload")) or {}
        if payload.get("revision_no") != r["revision_no"]:
            bad.append(f"任务 {r['task_id']} 修订 {r['revision_no']} 的事件里记的修订序号是 {payload.get('revision_no')}。")
        for op in payload.get("operations") or []:
            for side, word in (("from_revision", "改前"), ("to_revision", "改后")):
                no = op.get(side)
                if no is not None and (r["task_id"], op.get("item"), no) not in contents:
                    bad.append(f"修订 {r['revision_no']} 的事件说条目 {op.get('item')} {word}在修订 {no}，条目内容表里没有这一行。")
            if op.get("to_revision") is not None and op.get("to_revision") != r["revision_no"]:
                bad.append(f"修订 {r['revision_no']} 的事件说条目 {op.get('item')} 改后在修订 {op.get('to_revision')}，应当就是修订 {r['revision_no']}。")
    result("修订事件里的操作与条目内容表对得上", bad)

    # 8
    bad = []
    for e in rows["event"]:
        actor, call_id = e["actor"], str(e["call_id"])
        if actor not in (ACTOR_EXECUTOR, ACTOR_USER, LEGACY_ACTOR_MODEL):
            bad.append(f"第 {e['seq']} 号事件的发起方是「{actor}」，只能是 {ACTOR_EXECUTOR} 或 {ACTOR_USER}。")
        elif actor == ACTOR_USER and not call_id.startswith(USER_OPERATION_PREFIX):
            bad.append(f"第 {e['seq']} 号事件的发起方是用户，编号却是 {call_id}，用户的操作编号应当以 {USER_OPERATION_PREFIX} 开头。")
        elif actor != ACTOR_USER and call_id.startswith(USER_OPERATION_PREFIX):
            bad.append(f"第 {e['seq']} 号事件的发起方是执行者，编号却是 {call_id}，以 {USER_OPERATION_PREFIX} 开头的是用户的操作编号。")
    result("发起方与编号相符", bad)
    # 9
    bad = []
    adopted = {m["judgement_id"] for m in rows["model_call"] if m["judgement_id"] is not None and m["outcome"] == "采用"}
    for j in rows["judgement"]:
        basis = taskdb_json(j["basis"])
        in_ui = isinstance(basis, list) and any(isinstance(b, dict) and b.get("依据") in UI_BASES for b in basis)
        if not in_ui and j["judgement_id"] not in adopted:
            bad.append(f"第 {j['judgement_id']} 条确认标记（编号 {j['call_id']}）的依据不是已读、界面修改或界面点击，也找不到采用了的模型调用。")
    result("每条确认标记都说得出依据", bad)
    # 10
    bad = []
    for r in rows["review"]:
        if (r["task_id"], r["item_id"], r["revision_no"]) not in contents:
            bad.append(f"第 {r['review_id']} 条评审记录指向条目 {r['item_id']} 在修订 {r['revision_no']} 下的内容，内容表里没有这一行。")
    for j in rows["judgement_item"]:
        if (j["task_id"], j["item_id"], j["revision_no"]) not in contents:
            bad.append(f"第 {j['judgement_id']} 条确认标记指向条目 {j['item_id']} 在修订 {j['revision_no']} 下的内容，内容表里没有这一行。")
    result("评审与确认指向存在的（条目、修订）", bad)
    return results


def taskdb_json(text):
    import json
    try:
        return json.loads(text) if text else None
    except (TypeError, ValueError):
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="只读核对任务目录任务数据库里的记录互相对得上。")
    parser.add_argument("workspace", help="任务目录")
    args = parser.parse_args(argv)
    workspace = Path(args.workspace).expanduser().resolve()
    fmt = taskdb.format_of_workspace(workspace)
    if fmt in (taskdb.FORMAT_MISSING, taskdb.FORMAT_EMPTY):
        print(f"{taskdb.NO_TASK_YET}，没有要核对的记录。")
        return 0
    if fmt == taskdb.FORMAT_PRE_REVISION:
        print(f"{taskdb.PRE_REVISION_TEXT}不在本脚本的范围内。")
        return 1
    if fmt != taskdb.FORMAT_CURRENT:
        print(f"这个任务目录的库是{fmt}，不在本脚本的范围内；本产品不提供旧格式的核对。")
        return 1
    results = check(workspace)
    for index, one in enumerate(results, 1):
        print(f"{index}. {one['名目']}：{'通过' if one['通过'] else '不通过'}")
        for line in one["不通过的行"]:
            print(f"     {line}")
    failed = [one for one in results if not one["通过"]]
    print("全部通过。" if not failed else f"有 {len(failed)} 项不通过。")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
