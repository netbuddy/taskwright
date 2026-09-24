# User guide

This guide is for using Taskwright once it is running (see [deployment.md](deployment.md) for installation and model setup). It walks through one task in the web interface, from creating it to generating the document, then covers the example script, the other ways to work, and the observatory. It uses the bundled task type, *software requirements specification*, and the example material in `examples/library-lending/`.

Start the backend and the web interface with `scripts/dev.sh` (see [deployment.md](deployment.md)) and open `http://localhost:5680`.

## 1 Create a task

The interface is in Chinese; button names in this guide are given in English with the original label in parentheses. The page title is 需求工作台 (requirements workbench).

On the task list, choose **New task** (新建任务), pick the task type, give it a name (and optionally a domain tag), and choose **Create** (新建). The dialog does not take files; the new task's page opens instead.

The task page shows the task's status, its completion conditions, its materials and its sessions. Upload the materials in the **Materials** (材料清单) box: drag files onto it or click it to choose them. Only plain-text `.md` or `.txt` files up to 5 MB each are accepted. The assistant sees a newly uploaded material from the next session it starts, so upload before you open a session.

A task can have several sessions (conversations); all of them work on the same deliverable. Choose **New session** (新建会话) to open one; the work view opens. The assistant starts in the background, and a short status message (系统说明) at the top of the conversation tells it what the task looks like and which materials it has.

## 2 Talk with the assistant

The work view has three areas: the conversation, the items area (the deliverable, grouped by collection), and the document area (materials and generated documents).

Tell the assistant what you want, for example *"请读 inputs 里的材料，整理成需求规格说明。"* It reads the materials, writes items, and replies. Each reply lists what it just did, then says what it needs from you. When it needs you to do something, the reply ends with a card:

| Card | What it asks | Your options |
|---|---|---|
| Question | an open question | type your answer; if the question is about items, **Keep pending** (先不管这条, open issues only) or **I don't know, fill in from common sense** (我不知道，你按常识补) |
| Choose | pick one of several answers | click an option, or type your own |
| Confirm | accept these item versions | **Confirm** (确认), or **Not right** (不对, optionally with what is wrong) |
| Suggestion | a proposed value with its basis | **Adopt** (采纳) or **Another one** (换一个) |
| Proposal | a plan, with what it would add, change or remove | **Do it** (就这样做) or **Don't** (不要) |

You can always type instead of clicking. If the options don't include what you know, say it in your own words.

While the assistant works you can keep typing; your messages are delivered together when it finishes. The web interface has no stop button yet. To interrupt the assistant, send the `stop` control request of the HTTP API ([api.md](api.md), section 5.5): it clears the queued messages and interrupts the assistant, and what it already saved stays.

## 3 Work with the items

Each item shows its version, whether it passed review, and whether you confirmed this version. Click an item in the list to see every field and where each part came from:

- **Document excerpt** (材料原文): a verbatim quote from a material, with the file it came from;
- **Your words** (用户的话): something you said in the conversation;
- **Added by the assistant** (执行者补充): something it inferred or filled in, with its reason;
- **Your direct edit** (用户直接修改): a field you changed yourself.

You can act on the item directly with the buttons under it: **Edit** (修改) opens the fields for editing, and **Save as version N** (保存为第 N 版) saves them; **Delete** (删除) removes the item; **Confirm this version** (确认这一版) confirms it, and the button then reads **You confirmed · Withdraw** (你已确认 · 撤回); **Undo this revision** (撤销这次修订) takes back the latest revision. **‹ Back to list** (‹ 回到列表) returns to the list. Every change creates a new version; nothing is overwritten. If an item changed after you last looked at it (the assistant or another page changed it), your save is refused and you see the latest version to redo the change against.

Editing an item makes your earlier confirmation of it stale; confirm the new version again. After each change the assistant tells you which items it changed and asks you to confirm the new versions.

## 4 Finish and generate the document

The summary line above the item list (for example 12 个条目，1 个已确认；待定事项 3 条未解决 ▾, meaning "12 items, 1 confirmed; 3 open issues unresolved") opens the completion conditions, and the task page lists them too. For the bundled task type, every collection must meet its conditions (for example, every use case confirmed, and no open issue left unresolved). The assistant completes the task only when all conditions hold; after that the task is read-only.

Choose **Generate document** (生成文档), at the top of the items area or on the task page. In the dialog, tick the items and pick the version of each to include; the preview on the right follows your choice, and **Download Markdown** (下载 Markdown) saves the file. Versions that were not reviewed or not confirmed are included and marked as such. The document is rendered from the task type's template; no model rewrites it.

## 5 Try the example

`examples/library-lending/` contains a short, fictional requirements note for a school library ([`requirements.md`](../examples/library-lending/requirements.md)) and a script that runs the whole flow through the HTTP API only. With a task service running (see [deployment](deployment.md)):

```bash
examples/library-lending/run.sh http://127.0.0.1:8790
```

The script creates a task, uploads the note, opens a session, asks the agent to work, waits for its reply, and writes the generated document to `srs-<task id>.md` in the current directory. It needs only `curl` and `python3`, so it runs without the virtual environment. It prints the agent's progress every five seconds; with the default model a run usually takes one to three minutes and produces somewhere between ten and twenty items. The note deliberately leaves a few things open, so the agent has something to ask about.

The task it creates also appears in the web interface's task list, so you can open it there and continue.

## 6 Three ways to work with a task

| Interface | Command |
|---|---|
| Web (backend + browser interface) | `scripts/dev.sh`, then open `http://localhost:5680` |
| Terminal client | `python3 -m taskwright_server.create_task tasks/library --name "Library" --material examples/library-lending/requirements.md`, then `python3 -m taskwright_server.chat tasks/library` |
| pi's own terminal UI | `python3 -m taskwright_server.tui tasks/library` |

In the terminal client, type to talk; `/db` shows the deliverable and `/help` lists the other commands. In pi's terminal UI, type `/tw-board` to see the deliverable. Scripted use through the HTTP API is described in [api.md](api.md).

## 7 See what the assistant did: the observatory

The observatory is a read-only local web app; it never changes any data. It reads the task databases and the archives the backend writes for every start of pi.

```bash
python3 -m taskwright_observatory --runs ./runs/<task id> --workspaces ./tasks
# then open http://127.0.0.1:8770   (--port changes the port; Ctrl+C stops it)
```

- `--runs` is a task's archive directory, the directory that directly contains `pi-events/` and `pi-sessions/`. The task service creates one per task under its own `--runs`, so pass `./runs/<task id>`, not `./runs`: given the parent directory, the observatory finds no sessions and shows an empty list. Repeat `--runs` to see several tasks at once, for example every task the service has run:

  ```bash
  python3 -m taskwright_observatory $(for d in runs/*/; do printf -- '--runs %s ' "$d"; done) --workspaces ./tasks
  ```

- The terminal client writes `pi-events/` and `pi-sessions/` directly into `$TASKWRIGHT_RUNS_DIR` (default `./runs` under the directory you start it from), so for its sessions pass that directory itself. Sessions run in pi's own terminal UI produce no event archive and do not appear.
- `--workspaces` is the directory that holds the task directories (the service's `--tasks`).
- The observatory prints nothing when it starts; open the address above once the command is running.
- Files are re-read when they change: after a new session, refresh the browser.

The observatory's pages are in Chinese too; the table gives the tab names in parentheses.

| Page | What it shows |
|---|---|
| Sessions (会话列表) | one row per session: start and end, runs, turns, model requests, tool calls, rejected calls, outcome; each row links to its session details (进入会话详情) and its task page (进入任务页) |
| Tasks (任务) → task page | the task's history as stages; open a stage for the conversation and every change to the deliverable, open a turn for each tool call with its arguments, result and duration. The deliverable board shows each item's version, sources, review and confirmation, and which completion conditions are still missing. |
| Session details | the same view for a single session |
| System health (系统健康) | checks on the machinery: were the configured tools loaded, do the database rows match their events, were rejected calls later corrected |
| Concepts (概念对照) | what every term on the pages means |

A rejected tool call is marked where it happened; open the turn to read the reason the tool returned. With Langfuse configured, runs and tool calls also link to their Langfuse traces.

In a terminal, `python3 -m taskwright_observatory.dbshow tasks/<task id>` prints the task, its items with every version and source, the revisions and the latest events; `python3 -m taskwright_observatory.check_db tasks/<task id>` checks that the database rows and events agree.

[中文版](user-guide.zh-CN.md)
