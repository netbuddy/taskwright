"""评测：同一份画像接连演练几遍，每遍算灯与「至少应有」清单，再合成一份汇总，用来比较助手说明改动前后的效果。

用法（在代码仓根目录下）：

    python3 -m sim.evals run --persona sim/personas/library-short.json --expect sim/expectations/library-short.json \
        --materials-dir examples/library-lending --repeat 3 --port 8791 --label <这一次评测的名字> [--max-rounds 30] [--sim-root ./sim-runs]
    python3 -m sim.evals judge <演练目录> [--expect <清单文件>] [--persona <画像文件>]
    python3 -m sim.evals compare <前一次的标签> <后一次的标签> [--sim-root ./sim-runs]

run：演练的参数与 sim.run 相同（内部调它的 run_once，每遍各自起后端、各自出判定报告）。每遍跑完算灯（sim/lamps.py）、核对清单
（sim/expectations.py）、列出助手问过的问题与模拟用户答不上的问题（sim/questions.py），写进该遍目录的「评测.json」。
全部跑完在 sim-root 下写「评测汇总_<标签>.md」与「评测汇总_<标签>.json」，并往「evals.jsonl」追加一行。某一遍中途出错，
记下原因接着跑下一遍；那一遍的灯都是「算不了」，不计入通过率。标签在一个 sim-root 里不能重复：对照与页面都按标签找评测。

judge：对一遍跑过的演练重算「评测.json」（换了清单，或者往画像的「答不上的说法」里加了新说法之后用）。这一遍属于某次评测时，
那次评测的另外几遍用同样的清单与画像一并重算，两份汇总与 evals.jsonl 里的那一行跟着重写。

compare：两次评测的对照，打印一段 Markdown：每盏灯与清单的每一组各写两个数与差值，后一次比前一次低的标「变差」。
对照怎样算在观测台的 taskwright_observatory/evals.py 里，观测台的对照页面用的是同一份。

通过率怎样算：一盏灯的通过率是通过的遍数比上能算的遍数（结果是「通过」或「未通过」的遍），「不适用」与「算不了」不进分母；
一次评测的灯通过率是各盏通过率的平均。清单命中率是命中的组数比上组数，各遍合在一起算。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

from taskwright_observatory import evals as eval_files, taskdb

from sim import expectations, lamps, questions, run
from sim.launch_user import load_persona

RUN_FILE = "评测.json"
#: 演练根目录下的两种文件名，读它们的观测台与写它们的这里用同一份。
LIST_FILE = eval_files.LIST_FILE
SUMMARY_PREFIX = eval_files.SUMMARY_PREFIX


def summary_path(root: Path, label: str, suffix: str) -> Path:
    return Path(root) / f"{SUMMARY_PREFIX}{label}.{suffix}"


def check_label(label: str) -> str | None:
    """标签要能直接当文件名的一段用。不合用时返回原因。"""
    if not label.strip():
        return "标签不能是空的。"
    if any(c in label for c in "/\\\n\r") or label.startswith("."):
        return "标签不能带斜线与换行，也不能以句点开头（它要写进文件名）。"
    return None


def listed(root: Path) -> list[dict]:
    """sim-root 下已有的评测，每次一行，按追加的先后。"""
    path = Path(root) / LIST_FILE
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _seconds(record: dict) -> int | None:
    try:
        return int((datetime.fromisoformat(record["结束"]) - datetime.fromisoformat(record["开始"])).total_seconds())
    except (KeyError, TypeError, ValueError):
        return None


def judge_one(sim: Path, expect_path: Path | None = None, label: str | None = None, persona_path: Path | None = None,
              error: str | None = None) -> dict:
    """算一遍演练的灯、清单与两张问题清单，写进演练目录的「评测.json」并返回。
    清单与标签不给时沿用这一遍上次评测时用的；画像不给时用演练目录里的画像副本。"""
    sim = Path(sim)
    old = json.loads((sim / RUN_FILE).read_text(encoding="utf-8")) if (sim / RUN_FILE).is_file() else {}
    record = json.loads((sim / "record.json").read_text(encoding="utf-8")) if (sim / "record.json").is_file() else {}
    persona = load_persona(persona_path or sim / "用户画像.json") if (persona_path or (sim / "用户画像.json").is_file()) else {}
    expect_file = Path(expect_path) if expect_path else (sim / "至少应有.json")
    if expect_path:
        (sim / "至少应有.json").write_text(Path(expect_path).read_text(encoding="utf-8"), encoding="utf-8")
    expect = expectations.load(expect_file) if expect_file.is_file() else None
    db_dir = sim / "库副本"
    tasks = taskdb.read_workspace(db_dir)["任务"] if (db_dir / taskdb.DB_NAME).is_file() else []
    asked = questions.asked(sim, record)
    out = {
        "标签": label if label is not None else old.get("标签"),
        "演练": sim.name,
        "任务目录": record.get("任务编号"),          # 演练时任务目录的名字就是任务编号
        "任务编号": record.get("任务编号"),
        "画像": record.get("用户画像"),
        "清单": Path(expect_path).name if expect_path else old.get("清单"),
        "停止原因": record.get("停止原因"),
        "轮数": len(record.get("轮") or []),
        "轮数上限": record.get("轮数上限"),
        "开始": record.get("开始"),
        "结束": record.get("结束"),
        "用时秒": _seconds(record),
        "出错": error if error is not None else old.get("出错"),
        "灯": lamps.lamps_for_sim(sim)["灯"],
        "至少应有": expectations.check(expect, tasks[0]) if expect is not None and tasks else None,
        "助手问过的问题": asked,
        "模拟用户答不上的问题": questions.unanswered(persona, record, asked["问题"]),
    }
    (sim / RUN_FILE).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def summarize(root: Path, label: str, sims: list[Path], meta: dict) -> dict:
    """把几遍的「评测.json」合成一次评测的汇总。meta 是这次评测不随遍变的几样（时间、提交号、模型、材料等）。"""
    runs = [json.loads((sim / RUN_FILE).read_text(encoding="utf-8")) for sim in sims]
    lamp_rows = []
    for n, (stage, key, text) in enumerate(lamps.LAMPS):
        each = [next((x for x in r["灯"] if x["键"] == key), None) for r in runs]
        states = [x["结果"] if x else lamps.UNKNOWN for x in each]
        counted = [s for s in states if s in (lamps.PASSED, lamps.FAILED)]
        passed = states.count(lamps.PASSED)
        lamp_rows.append({"阶段": stage, "键": key, "说明": text, "各遍": states,
                          "各遍差的": [(x or {}).get("差的条目编号") or [] for x in each],
                          "各遍备注": [(x or {}).get("备注") or "" for x in each],
                          "通过遍数": passed, "能算的遍数": len(counted), "通过率": passed / len(counted) if counted else None})
    checked = [r for r in runs if r.get("至少应有") is not None]
    group_rows = []
    if checked:
        keyed = [None if r.get("至少应有") is None else {(x["部分"], tuple(x["组"])): x for x in r["至少应有"]} for r in runs]
        for first in checked[0]["至少应有"]:
            each = [None if one is None else one.get((first["部分"], tuple(first["组"]))) for one in keyed]
            hits = sum(1 for x in each if x and x["命中"])
            group_rows.append({"部分": first["部分"], "组": first["组"], "各遍": [None if x is None else bool(x["命中"]) for x in each],
                               "各遍命中的条目": [[] if x is None else x["命中的条目编号"] for x in each],
                               "各遍以例外开头": [None if x is None else x.get("以例外开头") for x in each],
                               "命中遍数": hits, "核对的遍数": len(checked)})
    rates = [row["通过率"] for row in lamp_rows if row["通过率"] is not None]
    total = sum(row["核对的遍数"] for row in group_rows)
    summary = {
        **meta, "标签": label, "遍数": len(runs),
        "各遍": [{"演练": r["演练"], "目录": str(sim), "任务的键": f"{r['任务目录']}/{r['任务编号']}" if r.get("任务编号") else None,
                  "停止原因": r.get("停止原因"), "轮数": r.get("轮数"), "用时秒": r.get("用时秒"), "出错": r.get("出错")}
                 for r, sim in zip(runs, sims)],
        "灯": lamp_rows, "至少应有": group_rows,
        "灯通过率": sum(rates) / len(rates) if rates else None,
        "清单命中率": sum(row["命中遍数"] for row in group_rows) / total if total else None,
        "各遍的问题": [{"演练": r["演练"], "怎样列的": r["助手问过的问题"]["怎样列的"], "问题": r["助手问过的问题"]["问题"]} for r in runs],
        "各遍答不上的": [{"演练": r["演练"], **r["模拟用户答不上的问题"]} for r in runs],
    }
    summary_path(root, label, "json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    summary_path(root, label, "md").write_text(summary_markdown(summary), encoding="utf-8")
    return summary


def percent(rate: float | None) -> str:
    return "没有能算的" if rate is None else f"{round(rate * 100)}%"


def summary_markdown(s: dict) -> str:
    n = s["遍数"]
    heads = "".join(f" 第 {i + 1} 遍 |" for i in range(n))
    lines = [f"# 评测汇总：{s['标签']}", "",
             f"- 时间：{s.get('时间')}",
             f"- 代码提交号：{(s.get('提交号') or '没有记')[:12]}" + (f"（另有 {s['未提交的改动']} 个文件有未提交的改动）" if s.get("未提交的改动") else ""),
             f"- 助手的模型：{s.get('模型') or '没有记'}；模拟用户的模型：{s.get('模拟用户的模型') or '没有记'}",
             f"- 材料：{'、'.join(s.get('材料') or []) or '没有'}；画像：{s.get('画像')}；清单：{s.get('清单')}",
             f"- 遍数：{n}；每遍的轮数上限：{s.get('轮数上限')}",
             f"- 灯通过率：{percent(s['灯通过率'])}；清单命中率：{percent(s['清单命中率'])}", "",
             "## 各遍", "", "| 遍 | 演练目录 | 停止原因 | 轮数 | 用时 | 出错 |", "|---|---|---|---|---|---|"]
    for i, r in enumerate(s["各遍"]):
        took = f"{r['用时秒'] // 60} 分 {r['用时秒'] % 60} 秒" if r.get("用时秒") is not None else "没有记"
        lines.append(f"| 第 {i + 1} 遍 | {r['目录']} | {r.get('停止原因') or ''} | {r.get('轮数')} | {took} | {r.get('出错') or '没有'} |")
    lines += ["", "## 灯", "", "每盏灯是这一段「算够」的一条判据，按演练结束时的任务数据算。「不适用」是这盏灯要看的那一类页或条目一个都没有，"
              "「算不了」是要用的数据取不到，这两种不计入通过率。", "",
              f"| 阶段 | 灯 |{heads} 通过几遍 |", "|---|---|" + "---|" * (n + 1)]
    for row in s["灯"]:
        # 未通过时写差的页或条目；没有编号可列（例如还没有评审过）或算不了时写备注。
        cells = "".join(f" {state}{('（差 ' + '、'.join(missing) + '）') if missing else ('（' + note.rstrip('。') + '）') if note and state in (lamps.FAILED, lamps.UNKNOWN) else ''} |"
                        for state, missing, note in zip(row["各遍"], row["各遍差的"], row["各遍备注"]))
        lines.append(f"| {row['阶段']} | {row['说明']} |{cells} {row['通过遍数']}／{row['能算的遍数']} |")
    lines += ["", "## 至少应有", "", "清单是下限：这份材料读透了至少应当整理出这些。一组里是同义的几种写法，出现一种就算命中。", ""]
    if s["至少应有"]:
        lines += [f"| 部分 | 关键词组 |{heads} 命中几遍 |", "|---|---|" + "---|" * (n + 1)]
        for row in s["至少应有"]:
            cells = "".join(" 没有核对 |" if hit is None else f" {'命中' if hit else '没有'}{('（' + '、'.join(ids) + '）') if ids else ''} |"
                            for hit, ids in zip(row["各遍"], row["各遍命中的条目"]))
            lines.append(f"| {row['部分']} | {expectations.group_label(row['组'])} |{cells} {row['命中遍数']}／{row['核对的遍数']} |")
    else:
        lines.append("这次评测没有核对清单（没有给清单，或者每一遍都没有跑完）。")
    lines += ["", "## 助手问过的问题", ""]
    for i, one in enumerate(s["各遍的问题"]):
        lines.append(f"### 第 {i + 1} 遍（{one['演练']}）")
        lines += [f"- {'第 ' + str(q['轮']) + ' 轮' if q['轮'] is not None else '轮次对不上'}，{q['功能']}：{q['文字']}"
                  + (f"（选项：{'；'.join(q['选项'])}）" if q.get("选项") else "") for q in one["问题"]] or ["- 这一遍助手没有向用户要过回应。"]
        lines.append("")
    lines += ["## 模拟用户答不上的问题", "",
              "模拟用户的话里出现了「不知道」「要问一下」一类说法时，把上一轮助手问的问题列在这里，请人过目：画像里确实没有这件事的，"
              "可以补进画像。这是按说法挑出来的清单，不是结论。", ""]
    for i, one in enumerate(s["各遍答不上的"]):
        lines.append(f"### 第 {i + 1} 遍（{one['演练']}）")
        for x in one["待人答"]:
            asked = "；".join(q["文字"] for q in x["上一轮的问题"]) or "上一轮助手没有提问"
            lines.append(f"- 第 {x['轮']} 轮，模拟用户说：「{x['用户 agent 的话']}」。上一轮的问题：{asked}")
        for x in one["画像里可能已有"]:
            asked = "；".join(q["文字"] for q in x["上一轮的问题"])
            lines.append(f"- 第 {x['轮']} 轮，模拟用户说：「{x['用户 agent 的话']}」。上一轮的问题：{asked}。"
                         f"画像里可能已有这件事（{'；'.join(x['画像里可能有的事实'])}），请看是不是模拟用户演错了。")
        if not one["待人答"] and not one["画像里可能已有"]:
            lines.append("- 没有。")
        lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


def list_line(summary: dict) -> dict:
    """evals.jsonl 里的一行：评测列表与对照要用的几样，完整内容在汇总文件里。"""
    return {"时间": summary.get("时间"), "标签": summary["标签"], "提交号": summary.get("提交号"), "未提交的改动": summary.get("未提交的改动"),
            "模型": summary.get("模型"), "模拟用户的模型": summary.get("模拟用户的模型"), "材料": summary.get("材料"),
            "画像": summary.get("画像"), "清单": summary.get("清单"), "遍数": summary["遍数"], "轮数上限": summary.get("轮数上限"),
            "各灯通过率": {row["键"]: row["通过率"] for row in summary["灯"]}, "灯通过率": summary["灯通过率"],
            "清单命中率": summary["清单命中率"], "各遍目录": [r["目录"] for r in summary["各遍"]],
            "汇总": summary_path(Path("."), summary["标签"], "json").name}


def write_list(root: Path, summary: dict) -> None:
    """把这次评测写进 evals.jsonl：标签已经在里面的换掉那一行，不在的追加在最后。"""
    rows = listed(root)
    line = list_line(summary)
    rows = [line if row["标签"] == line["标签"] else row for row in rows] if any(row["标签"] == line["标签"] for row in rows) else [*rows, line]
    (Path(root) / LIST_FILE).write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def command_run(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    if not args.materials_dir:
        parser.error("要给 --materials-dir，或者设环境变量 TASKWRIGHT_SIM_MATERIALS_DIR，指向用户画像里材料文件所在的目录。")
    if args.repeat < 1:
        parser.error("--repeat 至少是 1。")
    problem = check_label(args.label)
    if problem:
        parser.error(problem)
    root = Path(args.sim_root).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    if any(row["标签"] == args.label for row in listed(root)):
        parser.error(f"标签「{args.label}」在 {root} 里已经用过了。对照与页面都按标签找评测，请换一个标签。")
    persona_path, expect_path = Path(args.persona).resolve(), Path(args.expect).resolve()
    persona = load_persona(persona_path)
    expectations.load(expect_path)                      # 清单读不出来就在开跑之前报错
    started = time.strftime("%Y-%m-%dT%H:%M:%S")
    sims: list[Path] = []
    for i in range(args.repeat):
        sim = run.next_sim_dir(root)
        sims.append(sim)
        print(f"评测「{args.label}」第 {i + 1} 遍，共 {args.repeat} 遍", flush=True)
        error = None
        try:
            run.run_once(args, persona_path, persona, sim)
        except Exception as caught:                     # 一遍出错不拖垮整次评测：记下原因，接着跑下一遍
            error = f"{type(caught).__name__}：{caught}"
            print(f"{sim.name} 出错：{error}", flush=True)
        judge_one(sim, expect_path, args.label, error=error or "")
    record = json.loads((sims[0] / "record.json").read_text(encoding="utf-8")) if (sims[0] / "record.json").is_file() else {}
    version = record.get("代码版本") or run.code_version()
    summary = summarize(root, args.label, sims, {
        "时间": started, "提交号": version.get("提交号"), "未提交的改动": len(version.get("未提交的改动") or []),
        "模型": record.get("执行者模型"), "模拟用户的模型": record.get("用户 agent 模型"), "材料": persona.get("材料") or [],
        "画像": persona_path.name, "清单": expect_path.name, "轮数上限": args.max_rounds})
    write_list(root, summary)
    print(f"灯通过率 {percent(summary['灯通过率'])}，清单命中率 {percent(summary['清单命中率'])}；评测汇总：{summary_path(root, args.label, 'md')}", flush=True)
    return 0


def command_judge(args: argparse.Namespace) -> int:
    sim = Path(args.sim).resolve()
    expect, persona = (Path(args.expect) if args.expect else None), (Path(args.persona) if args.persona else None)
    out = judge_one(sim, expect, None, persona)
    print(sim / RUN_FILE)
    root, label = sim.parent, out.get("标签")
    old = next((row for row in listed(root) if row["标签"] == label), None) if label else None
    if old and summary_path(root, label, "json").is_file():
        before = json.loads(summary_path(root, label, "json").read_text(encoding="utf-8"))
        sims = [Path(r["目录"]) for r in before["各遍"]]
        for other in sims:
            if other.resolve() != sim:
                judge_one(other, expect, None, persona)
        meta = {key: before.get(key) for key in ("时间", "提交号", "未提交的改动", "模型", "模拟用户的模型", "材料", "画像", "清单", "轮数上限")}
        if expect:
            meta["清单"] = expect.name
        write_list(root, summarize(root, label, sims, meta))
        print(f"这一遍属于评测「{label}」，另外几遍已经一并重算，汇总已经重写：{summary_path(root, label, 'md')}")
    return 0


def command_compare(args: argparse.Namespace) -> int:
    root = Path(args.sim_root).expanduser()
    try:
        print(eval_files.compare_markdown(eval_files.compare(root, args.first, args.second)), end="")
    except eval_files.EvalNotFound as error:
        print(f"{error}（在 {root} 里找）", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m sim.evals", description="评测：多遍演练，每遍算灯与「至少应有」清单，合成汇总。")
    commands = parser.add_subparsers(dest="command", required=True)
    run_parser = commands.add_parser("run", parents=[run.build_parser(add_help=False)], help="接连演练几遍并写评测汇总")
    run_parser.add_argument("--expect", required=True, help="「至少应有」清单文件")
    run_parser.add_argument("--label", required=True, help="这一次评测的名字，例如助手说明的版本；在一个 sim-root 里不能重复")
    judge_parser = commands.add_parser("judge", help="对一遍跑过的演练重算评测")
    judge_parser.add_argument("sim", help="演练目录")
    judge_parser.add_argument("--expect", default=None, help="换一份清单；不给就用这一遍上次用的")
    judge_parser.add_argument("--persona", default=None, help="换一份画像（改了「答不上的说法」之后用）；不给就用演练目录里的画像副本")
    compare_parser = commands.add_parser("compare", help="两次评测的对照")
    compare_parser.add_argument("first", help="前一次评测的标签")
    compare_parser.add_argument("second", help="后一次评测的标签")
    compare_parser.add_argument("--sim-root", default=str(Path.cwd() / "sim-runs"))
    args = parser.parse_args(argv)
    if args.command == "run":
        return command_run(args, run_parser)
    if args.command == "compare":
        return command_compare(args)
    return command_judge(args)


if __name__ == "__main__":
    sys.exit(main())
