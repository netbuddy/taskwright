# User guide

This guide is for using Taskwright once it is running (see [deployment.md](deployment.md) for installation and model setup). It walks through one task in the web interface, from creating it to generating the document, then covers the example script, the other ways to work, and the observatory. It uses the bundled task type, *software requirements specification*, and the example material in `examples/library-lending/`. If you would rather follow one task step by step with screenshots first, start with the [tutorial](tutorials/srs-authoring.md).

Start the backend and the web interface with `scripts/dev.sh` (see [deployment.md](deployment.md)) and open `http://localhost:5680`.

## 1 Create a task

The interface is in Chinese; button names in this guide are given in English with the original label in parentheses. The page title is 需求工作台 (requirements workbench).

On the task list, choose **New task** (新建任务), pick the task type, give it a name (and optionally a domain tag), and choose **Create** (新建). The dialog does not take files; the new task's page opens instead.

The task page shows the task's status, its completion conditions, its materials and its sessions. Upload the materials in the **Materials** (材料清单) box: drag files onto it or click it to choose them. Plain-text `.md` or `.txt` files and Word `.docx` files up to 5 MB each are accepted. For a Word file the service also generates a Markdown text for the assistant, which keeps the headings, numbering, lists and tables and links the pictures; the list does not show that text, and **View** (查看原文) on a Word file shows the file page by page in its original layout. The assistant sees a newly uploaded material from the next session it starts, so upload before you open a session.

A task can have several sessions (conversations); all of them work on the same deliverable. Choose **New session** (新建会话) to open one; the work view opens. The assistant starts in the background, and a short status message (系统说明) at the top of the conversation tells it what the task looks like and which materials it has.

## 2 Talk with the assistant

The work view has three columns: the conversation, the items area (the deliverable, grouped by collection), and the side panel with three tabs: **Materials** (材料, the uploaded texts), **Document** (文档, generating documents) and **Revisions** (修订, the revision log, see section 3). A task whose definition asks for it gets one more tab after Materials: in a requirements task, **Domain notes** (领域说明) lists the task's domain notes grouped by category, terms first, each with how it is linked to other items; a note not linked to any item says so in amber, and clicking a note opens it in the items area. **Collapse** (收起) folds the side panel into a narrow strip; on narrow windows it starts folded. **Font size** (字号 小 中 大) in the top bar makes all text smaller or larger; text also scales with the window width, and the choice is kept in the browser.

Tell the assistant what you want, for example *"请读 inputs 里的材料，整理成需求规格说明。"* It reads the materials, writes items, and replies. Each reply lists what it just did, then says what it needs from you. When it needs you to do something, the reply ends with a card:

| Card | What it asks | Your options |
|---|---|---|
| Question | an open question | type your answer; if the question is about items, **Keep pending** (先不管这条, only for items in the issues collection, 问题) or **I don't know, fill in from common sense** (我不知道，你按常识补) |
| Choose | pick one of several answers | click an option, or type your own |
| Confirm | a clear answer about these items as they are now (used only when the assistant really needs one) | **I've read these** (这几条都看过了), which marks the items as read, or **Not right** (不对, optionally with what is wrong). Each item line shows its current revision and whether you have read it, for example 修订 9（已读）("read"), 修订 9（未读）("unread"), or 修订 9（已读 · 你看过修订 4，之后又改过）("read · you read revision 4, changed since") when you read an earlier revision. |
| Suggestion | a proposed value with its basis | **Adopt** (采纳) or **Another one** (换一个) |
| Proposal | a plan, with what it would add, change or remove | **Do it** (就这样做) or **Don't** (不要) |

You can always type instead of clicking; you do not have to answer the card first. If the options don't include what you know, say it in your own words.

After changing items the assistant only tells you what it changed; it does not ask you to confirm. You confirm an item by reading it: opening its details counts (see section 3). Before asking whether to complete the task, the assistant tells you how many items you have never read. When nothing but unread items stands in the way of completing, a live card also shows 还有 N 条未读 ("N items still unread") with **Show them** (筛出来看), which filters the list to the unread items.

**One at a time.** Only one party changes the deliverable at any moment:

- **While the assistant works**, a banner at the top of the items area says 助手正在工作，结束后你可以继续修改 ("the assistant is working; you can continue editing when it is done"). Every write button on the items (edit, save, delete, mark as read, keep pending, undo) is greyed out, and hovering over a greyed-out button tells you why, and the send button is greyed out too: one message starts one piece of work, and the next message waits until it is done. You can still type; your draft stays in the input box. **Let the assistant change this one** (让助手来改这一条) and **Answer this question** (回答这个问题) stay available, because they only prefill the input box. The HTTP API refuses messages and direct operations sent during this time with `session_busy`. Opening an item's details still marks it as read, because that does not change the deliverable.
- **While you have unsaved changes** in an item's editor (the editor is open and its content differs from when you opened it), the send button and the buttons on cards are greyed out, with the hint 先保存或取消正在编辑的条目 ("save or cancel the item you are editing first"). Save or cancel, and they come back.

The web interface has no stop button yet. To interrupt the assistant, send the `stop` control request of the HTTP API ([api.md](api.md), section 5.5); what it already saved stays.

When a piece of work produced revisions, a small tag at the bottom of the reply says so, for example 产生了修订 8、9 ("produced revisions 8, 9"). Click it to open those revisions in the Revisions tab.

## 3 Work with the items

Every save of the deliverable is a **revision**, numbered from 1 within the task: each save by the assistant and each direct operation of yours (edit, delete, keep pending, undo) creates exactly one. Items have no version numbers of their own; an item "is at revision N" when N is the last revision that added, changed or restored it. Marking as read does not create a revision.

Each item carries at most one coloured status badge, saying what the item still lacks. When several things are open, only the first of these is shown: 评审不通过 N 处 ("failed review, N problems", red), 未读 ("unread", amber), 待评审 ("waiting for review", grey), 评审不通过 N 处 · 已保留 ("failed, kept", green outline: you kept the wording, so it counts as passed) and 问题 N 未解决 ("N open questions", amber). An item that lacks nothing has no badge. Hover over the badge to see the whole state: the review result, the revision you last read and the number of open questions. Collections that are not reviewed (issues, domain notes) never show the three review badges. Unread rows are in bold like an unread e-mail. The rest is small grey text: the category, 修订 N once the item has changed more than once (修订 N · 刚改 in bold when the assistant's last piece of work changed it), the number of sources and 有助手补充的内容 ("has content added by the assistant"). The details header shows the same badges, and below them one grey line such as 已读 · 现在是修订 4，由助手写的 · 来源 3 条 ("read · now at revision 4, written by the assistant · 3 sources"). Click an item in the list to see every field and where each part came from. **Opening the details marks the item as read, and reading counts as confirming**; there is no confirm button. Only opening the details counts; seeing an item in the list does not. Read is per item: once you have read an item it stays read, even if the assistant changes it later. The four kinds of source tag are:

- **Document excerpt** (材料原文): a verbatim quote from a material, with the file it came from; click it to see the sentence highlighted in the Materials tab (an excerpt made of several passages is highlighted passage by passage, scrolled to the first one); when none of it can be found in the material, the top of the Materials tab says 没有在材料里找到这段原文 ("this passage was not found in the material") for two seconds. A Word material is shown page by page in its original layout, and its excerpts are labelled with the page, the section and the position on the page, for example `requirements-styled.docx · 第 3 页 · 3.1.1 逾期罚款 · 页下` (page 3, section 3.1.1, lower part of the page); an excerpt that runs over several paragraphs has all of them marked and the tab says 这段引用跨越了多个段落，已整段标出 ("this quote spans several paragraphs, all of them are marked"). Text in headers, footers, text boxes, footnotes and endnotes can be read but not quoted; comments are not shown and tracked changes are shown as accepted;
- **Your words** (用户的话): something you said in the conversation;
- **Added by the assistant** (助手补充): something it inferred or filled in, with its reason;
- **Domain note** (领域说明 DN-002): an explanation already recorded in the Domain notes collection (领域说明: background, terms and roles from the material or from what you explained, for items to cite); click it to open that note. A domain note's details list which items cite it or link to it (被哪些条目引用). Collections that are not reviewed, such as issues and domain notes, show no review state in the items area or on the task page;
- **Your direct edit** (用户直接修改): a field you changed yourself.

The drop-down at the top right of an item lists the revisions in which it changed; choose one to see the item as it was then, with the differences from its previous change marked. If the list of revisions could not be loaded, the drop-down says 修订列表没读到，再打开一次试试 ("the revision list did not load; open the item again"); go back to the list and open the item again.

**What the assistant changed since you last confirmed.** Fields the assistant changed since the revision you last confirmed (or since the item was added, if you never confirmed it) are framed with an amber left border, and the note at the top says 与你上次确认的修订 K 相比，改了这几处 ("compared with revision K, which you last confirmed, these places changed"): struck-through text is how revision K put it, underlined text is how it reads now. Changes accumulate across several revisions. Fields you changed yourself are not framed. Because opening the details marks the item as read, the frames are fixed when you open it: they stay while the details are open and are gone the next time you open the item. The frames and 刚改 only point out what the assistant changed; they do not affect whether the item is read and do not block completion. Items changed by the assistant's most recent piece of work are marked 修订 N · 刚改 ("revision N · just changed") in the list.

You can act on the item directly with the buttons under it: **Edit** (修改) opens the fields for editing and **Save** (保存) saves them as a new revision; **Delete** (删除) removes the item; **Keep pending** (先不管，保留) sets an issue item's status to kept by your decision. The bottom right of the item only shows its status; reading cannot be withdrawn. An issue item cannot be edited directly once it is written: its details only offer **Keep pending** and **Delete**. To answer it, tell the assistant in the conversation; it changes the items the issue concerns and then asks you whether the issue is settled. Saving your own edit, or keeping an issue pending, also counts as confirming that item. Tick several items in the list and click **Mark these as read** (把选中的这几条标为已读) to mark them together. **‹ Back to list** (‹ 回到列表) returns to the list. Every change creates a new revision; nothing is overwritten.

**Questions follow the items they concern.** An issue item's related items (关联条目) tie it to those items. In the list, an item that unresolved issues point at carries an amber **问题 N** badge ("N questions") next to its status badge; it counts only unresolved issues and disappears at 0. When the questions are the only thing an item still lacks, its one badge reads 问题 N 未解决 instead. An issue item itself only shows its own status: 未解决 (unresolved, amber), 已解决 (resolved, green) or 用户决定保留 (kept by you, green outline). The item's details open with **挂在这条上的问题** ("questions on this item"): one card per issue with its kind, status, text and the assistant's suggested handling. On an unresolved card, type your answer and click **Answer** (回答): the conversation receives "回答 TBD-002：<your answer>" and the assistant changes the items the issue concerns; with the box empty, **Answer** only prefills the conversation input. **Keep pending** (先不管，保留) works as elsewhere. Resolved and kept issues are dimmed and show their outcome and the revision they were settled in. These buttons are greyed out under the same rules as the other write buttons, and **Answer** also while an item edit is unsaved. Clicking a related item on an issue card in the Issues tab opens that item with **‹ Back to the question list** (‹ 回到问题列表) at the top; that issue's card comes first and is highlighted, and the other issues fold into one line **还有 N 个问题 ▸** ("N more questions") that opens on a click. Issues without related items stay only in the Issues tab.

If the same item is open in two browser tabs and one of them saves first, the other tab's save is refused: a red message at the top right says the item has been changed to revision N, and stays until you close it. Nothing is merged; click **打开最新** ("open the latest") in the message to leave the edit and see the current content, then make your change again.

**Messages at the top right.** Things that just happened are reported in one place, the top right of the page, newest on top and at most three at a time: success (green, fades after 4 seconds), in progress (blue, with a progress bar, replaced by the result), warning (amber, fades after 8 seconds and comes back while the situation lasts, for example while the connection to the server is lost) and failure (red, stays until you click ×). Hovering over a message pauses its timer. Some messages end with an action, such as 打开最新 or 看评审页签 ("open the Review tab"). A message you sent that could not be delivered also stays in the conversation, marked as not sent, so you can send it again.

When the assistant changes an item you had read, the item stays read; the list marks it 修订 N · 刚改 ("revision N · just changed") and its details show the changed fields, and it is up to you whether to look again. The line 还有 N 条未读 · 筛出来看 ("N items unread · show them") above the list, and the **Unread** (未读) filter, list the items you have never opened.

**The Revisions tab** (修订) lists every revision of the task, newest first. Each card shows 修订 N · time · 助手 (the assistant) or · 你在界面上改的 (changed by you in the interface), what triggered it: 因为你说：纠正：UC-003 的参与者改为借还台管理员 ("because you said: correct: …") when the assistant recorded its understanding of your message and the revision matches one of the acts in it, otherwise which of your messages it answered, which card you clicked, or which direct operation you made, and one line per item it touched: added, changed, deleted or restored, and which fields changed, with **Show changes** (查看差异). Click a card to highlight the items it touched in the items area; the collection tabs show how many, and 修订 N 碰到的条目 ✕ in the filter line clears it. **Undo this revision** (撤销这次修订) creates a new revision that puts every item of that revision back the way it was (a deleted item comes back, an added one is deleted). If one of those items has changed again since (or has been deleted), the revision cannot be undone: the button is greyed out beforehand, and hovering over it says 这次修订碰到的条目之后又改过，不能撤销；要改请直接改条目 ("an item this revision touched has changed since, so it cannot be undone; edit the item directly instead"). **Generate a document from this revision** (按此修订生成文档) opens the document dialog for that revision. The tab stays readable while the assistant works; only undo is greyed out.

**Review.** Items in the use case, non-functional requirement and constraint collections must pass review before the task can be completed. You start the review: **Review N items waiting for review** (评审 N 条待评审的条目) at the top of the items area reviews every item that has no review at its current revision, **Review this item** (评审这条) in an item's details reviews that item, and **Review these N** (评审这 N 条) in the completion conditions reviews the items listed there. The buttons are greyed out while the assistant works. The review runs in the background, about ten seconds per item and four at a time, and you can keep working: a blue message at the top right shows 评审中 3/12 ("reviewing 3 of 12") with the items being reviewed, and turns into the result with a link to the Review tab when the review ends. The reviewer checks each item against numbered rules (for example UC-R7). A finding under a required rule is a **problem** (red) and fails the item; a finding under an optional rule is **advice** (amber) and does not. Findings appear next to their fields; click the rule number after 违反 ("violates") to read the rule, and click **Let the assistant fix this** (让助手照这条改) to put a request into the message box. After the item changes, or after the rules change, it waits for review again; an item that has not changed can be reviewed again only through 仍要重评 ("review again") next to **Review this item**, after a confirmation. The **Review** tab (评审) in the side panel lists every review as 第 N 次评审 ("review N"), with each item's findings and whether each one is still open (未处理), fixed in a later revision (已在修订 N 改) or kept (已保留); **Only open** (只看未处理) filters them, and the tab's badge counts open problems. Next to an item that failed, **Keep X's current wording** (保留 X 现在的写法, with an optional reason) keeps it: it counts as passed by your decision; if the item changes, it must be reviewed again. The same is offered on the second line of each finding in the item's details (保留这种写法), where the finding's status and your reason appear and **Withdraw** (撤销保留) undoes it; the item's badge then reads 评审不通过 N 处 · 已保留. At the bottom of the tab you can switch optional rules off or make them required for this task; required rules are locked. Switching a rule sends the collection's items back to waiting for review; earlier reviews are kept. When a review ends, the conversation shows one line, 评审完成：X 条合规、Y 条不合规…, with a link to the Review tab. The filters 待评审 (waiting for review), 评审不通过 (failed review) and 评审通过 (passed review) list the items in each state. The assistant does not review on its own; if you ask it to review in the conversation, it does so and tells you the results.

## 4 Finish and generate the document

The summary line above the item list (for example 12 个条目 · 待评审 4 · 评审不通过 1 · 3 条未读；问题 3 条未解决 ▾, meaning "12 items, 4 waiting for review, 1 failed review, 3 unread; 3 issues unresolved") opens the completion conditions, and the task page lists them too. For the bundled task type, every collection must meet its conditions (for example, every use case has passed review, no use case is one you have never read, and no issue item is left unresolved). The review condition lists the items not reviewed yet, the items that failed, and the items that failed but whose wording you kept (they count as passed), with **Review these N** and **Open X** (打开 X) buttons. The assistant first tells you which items you have never read; when all conditions hold, it asks you on a Choose card whether to complete now; it completes the task only after you agree, and after that the task is read-only.

Choose **Generate document** (生成文档) at the top of the items area, in the Document tab, on the task page, or on a card in the Revisions tab. In the dialog, choose one revision (the latest by default) and tick the items to include; the list shows the items that were in the deliverable at that revision. The whole document is rendered as of that revision, and the preview on the right follows your choice. **Download Markdown** (下载 Markdown) saves the file. The document starts with the revision it was generated from, and each item is marked with the revision its content comes from and whether it was confirmed and reviewed in that revision (a confirmation says on what basis: 已读 read, 用户修改 your own edit, or 明确确认 an explicit confirmation from an older version); unconfirmed and unreviewed items are included and marked as such, except that issue items are listed with their kind and status only. The document is rendered from the template in the task directory; no model rewrites it. You can generate it at any time, also after the task is completed. The [tutorial](tutorials/srs-authoring.md#act-6-take-the-document-and-look-back-at-what-the-agent-did) shows documents generated from the latest and from an earlier revision.

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
| Tasks (任务) → task page | the task's history as stages; open a stage for the conversation and every change to the deliverable, open a turn for each tool call with its arguments, result and duration. The deliverable board shows each item's current revision, sources, review and confirmation, and which completion conditions are still missing; click an item to see it in every revision in which it changed. The head has a line 对话 ("dialogue") with three facts: the assistant's acts still waiting for your answer, items the assistant asked about in two or more runs in a row without an answer, and fields changed at your request two or more times. Each run row shows its run number within the session (运行号 rN, not the same number as the row's sequence number across the task) and, when the run ended without a valid understanding of what you said, 这一轮没有合格的理解 ("no valid understanding this run"), at most once per run; an open run shows its dialogue acts, and in grey any JSON fragments the assistant wrote that matched no registered format or could not be parsed (diagnostics only, not failures), each with its first 200 characters and the validation or parse errors: your acts on the left (function such as 纠正（correct）, the items and fields, which assistant act it answers, how sure the assistant was, a summary) and the assistant's acts on the right, each marked 已回应（rN-M） answered, 等回应 waiting, or 不等回应 needs no answer. |
| Session details | the same view for a single session |
| System health (系统健康) | checks on the machinery: were the configured tools loaded, do the database rows match their events, were rejected calls later corrected |
| Concepts (概念对照) | what every term on the pages means |

A rejected tool call is marked where it happened; open the turn to read the reason the tool returned. With Langfuse configured, runs and tool calls also link to their Langfuse traces.

In a terminal, `python3 -m taskwright_observatory.dbshow tasks/<task id>` prints the task, its items with the revisions in which each changed and their sources, the revisions and the latest events; `python3 -m taskwright_observatory.check_db tasks/<task id>` checks that the database rows and events agree.

[中文版](user-guide.zh-CN.md)
