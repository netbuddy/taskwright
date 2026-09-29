# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Web pages

- The deliverable board on the task page no longer shows 评审通过 0/0 and 已读 0/0 in amber for a collection without items; it shows only 0 个条目 ("0 items") and 这个集合还没有条目。 ("this collection has no items yet"). Its grey lines address you throughout; before, one sentence switched to 用户 ("the user") halfway.
- The task page opens an event stream without a session and listens only to `executor_state`: when the assistant finishes a turn it reloads the task, so the last activity and each session's message count and last activity no longer stay as they were when the page was opened. The stream is not opened for a completed or abandoned task and is closed when you leave the page.
- A 502, 503 or 504 without an explanation, which a forwarding layer such as the development server's proxy returns while the task service is stopped or restarting, now reads 连不上任务服务，可能正在重启。请稍后再试；一直不行，请告诉管理员。 ("cannot reach the task service, it may be restarting; try again later, and tell your administrator if it keeps failing") instead of 请求没有成功（HTTP 502）。 ("the request failed (HTTP 502)"). This applies to ordinary requests, to reading a Word file for the original-layout view and to downloading a document; an explanation from the task service itself is still shown as it is.
- Error notes in the material pane, the document preview and the Word original-layout view wrap inside their box; a long string without spaces could run past the right edge before.
- When the input box is disabled or you have unsaved item edits, the send button's hover text is 现在不能发送，原因见上方。 ("you cannot send now; the reason is shown above") instead of repeating the notice above the input box.
- 被 N 个条目引用过 ("cited by N items") on the Materials tab counts every item whose excerpt is found in the material. It used to miss an item whose excerpt overlapped another item's, and dropped further while a passage was highlighted.
- The question on the green submit bar names the collections you must have read that are not reviewed, such as the domain notes, with their count, and says the issues are all resolved or kept pending only when there are issue items; before, it left the domain notes out and always said 没有未解决的问题 ("no unresolved issues").
- After a page reload the conversation stays at the bottom when the revision tags appear; before, it could stop at the top with the last line half hidden behind the input box when the conversation was just over one screen long. It does not scroll if you have scrolled up.

### When the assistant is not available

- When the assistant's program exits right after it starts, the work view says 助手现在不可用：助手启动之后立刻退出了。请把这个页面的地址告诉管理员。 ("the assistant exited right after it started; tell your administrator the address of this page") instead of showing what the program wrote to its error output, which could carry file paths and internal words. That text goes to the backend log and stays in `data.detail` of `executor_unavailable`. Other unexpected start errors say 助手现在不可用：助手没有启动起来。请把这个页面的地址告诉管理员。 ("the assistant did not start").
- When the task service cannot prepare the assistant's files before starting it (creating the archive directory, opening the archive files, or backing up and rewriting a session file it resumes; for example no write permission or a full disk), the work view says 助手现在不可用：启动助手之前，任务服务没能写入它要用的文件，系统原因：EACCES。请把这个页面的地址告诉管理员。 with the system's code, or 系统原因：未知 ("unknown") when there is none, instead of the system's English message; the path goes to the backend log only. The archive files opened so far are closed and the empty ones created by that start are removed.

### Conversation and work view

- The task status note at the top of a session opens with 这条会话开始时（time）的任务状况： ("the task at the start of this session") or, when a session is resumed, 接着这条会话继续时（time），上次之后交付物的变化： ("continuing this session, changes to the deliverable since last time"), instead of an opening written for the assistant that named the 执行者 ("executor") and the 扩展 ("extension"). In the note, 执行者在别的会话里做的 N 次 reads 助手在别的会话里做的 N 次 ("done by the assistant in other sessions"), and the line listing the assistant's acts still waiting for an answer is not shown. The assistant still reads the original text; the page gets the same wording live and after a reload.
- A page reloaded while a review is running shows 评审中 ("reviewing") and the greyed-out **Review** button at once, instead of waiting for the next item to be reviewed. A review that was cut off because the assistant's program exited is no longer shown as running after a reload.

### Task service and API

- The snapshot has `review_in_progress`: the review started from the interface that is running now (`op_id`, `done`, `total`, `current`, as in `review_progress`), or null when there is none, the agent is not running, or its progress was written before the agent's current start.
- `step_count` of `work_ended` is computed from the session record, like that of `work_summary`. When a turn was stopped halfway through a message with several tool calls, the calls that never started were counted in the summary but not in `work_ended`.
- The API reference now documents `cleared` in the answer to a stop request (always empty, since no message is queued while the agent works) and says that database event numbers can skip, since a few kinds of records are not pushed.
- An absolute path in a startup profile (`system_prompt_file`, `platform_skill`, the `path` of an extension from the repository) is used as it is; before, it was joined to the repository root.

### Observatory

- The deliverable board follows the latest review of an item's revision and shows a wording kept after it as 已保留写法 ("wording kept"), drawn like a pass; before, a kept item was shown as 评审过，没有通过 ("reviewed, not passed"), and an item that once passed stayed passed after a later failed review. The rule fingerprint is still not taken into account.

### Issue items and sources

- Marking an issue resolved or kept by the user's decision needs a click from the user. `save_revision` refuses to set an issue item's status to 已解决 ("resolved") or 用户决定保留 ("kept by the user's decision") until the user has clicked 已解决 or 先不管，保留 ("leave it for now") on a Choose card that names the issue item, and the issue item and its related items have not changed since that click, whoever changed them; the latest click counts, and typed words do not count. The refusal says to send the card first. A new issue item can no longer be written with either status. Keeping an issue pending from the page is not affected.
- When the assistant updates an item, the item's existing sources are kept. Before, giving a source for a field replaced every source of that field, so adding an entry to a list such as 约束规则 ("constraint rules") dropped the material source of an entry that had not changed. Entries of a list are now recognised by their content, so a source follows its entry when entries are inserted, removed or reordered; before, it stayed at the same position and silently pointed at another entry, or the save was refused when the list became shorter. A source on an entry that was removed goes with it. A source on content the assistant rewrote stays, and the save result reminds the assistant to check it. To remove a source, the assistant relabels the item with sources only, and the save result lists what was removed. Your own edits in the interface still replace the sources of the fields you changed.

## [0.3.0-alpha] - 2026-09-28

In 0.3 the task service is rewritten in TypeScript, so the task service, the web pages and the assistant need only Node, and the product can be started from a single executable; the observatory and the simulator are still Python programs. Word materials are read by the assistant as Markdown, with a segment list and a location table beside them. Reviews, uploads and completing a task follow stricter rules.

### Completing a task

- Completing a task needs a click from the user; typed words such as 完成吧 ("finish it") do not count. When every completion condition is met at the end of the assistant's turn, the assistant asks with a Choose card that states the facts and what submitting means, with the options 已完成，提交交付物 ("finished, submit the deliverable") and 还没完成，继续修改 ("not finished, keep editing"). When the conditions become met through what the user does on the page while the assistant is not working, the work view shows a green bar above the items with the same question and one button, 已完成，提交交付物; it asks for confirmation and then completes the task without starting the assistant. The bar is hidden while the assistant works or while its card asking the same question is unanswered.
- The agreement holds as long as the deliverable has no new revision; reading items, reviews and kept wordings create no revision. The latest click counts. `complete_task` checks the completion conditions first and the agreement second, and a refusal says which is missing. From the page the task is completed through a new direct operation, `submit_deliverable` (`fields.revision_no`, the revision the page showed), with the user as the actor and a note in the conversation; a revision that is no longer the latest is refused. In the conversation a refused `complete_task` step reads 完成任务没有做成 ("completing the task did not succeed") instead of 完成任务被拒，完成条件还没满足 ("completing the task was refused, the completion conditions are not met yet"), since the call can now be refused although every condition is met.
- The hint 还有 N 条未读 ("N items unread") under a reply card appears only when unread items are the only condition left before the task can be completed; before, it also appeared while items still awaited review.

### Reviews

- An item is reviewed once per revision and rule set. The 仍要重评 ("review again") link and its confirmation are gone, and `force` no longer has any effect. An item is reviewed again after it changes or after the rules change. The greyed-out **Review this item** (评审这条) says why, and for an item that failed and was not kept it adds that the item can be changed and reviewed again, or its wording kept.
- One shared rule decides the review result everywhere: the item badge, the filters, the completion conditions, the Review tab, the task page, the generated document and what the assistant reads. For tasks that hold several reviews of one revision from 0.2, the latest review under the current rules counts, and a kept wording counts only if it was kept after that review. Stored reviews are not changed.
- A failed review whose wording you kept is no longer shown as failed, and it is not counted among the passed items either; for the completion conditions it still counts as passed, as in 0.2. The summary line above the item list counts it as 已保留写法 N ("wording kept"), the 评审不通过 filter lists only failed items that were not kept, a new filter 已保留写法 lists the kept ones, and the deliverable board on the task page shows 评审通过 N/M · 已保留写法 K.
- After the review rules change, a finding made under the earlier rules reads 按改之前的规则评出，不再算数 ("made under the earlier rules, no longer counts") in the Review tab, has no action links, and is left out of the tab's badge and of **Only open**. The generated document writes 未评审 for an item that has no review under the current rules.
- Reviews and kept wordings in the task data (`items[].reviews[]`, `items[].waivers[]` and the reviews in an item's revisions) carry `seq`, the number of the event they were recorded at. Reviews made now are recorded with `forced` false, and the `forced` list of `review_batch` is empty.
- Clicking **Review** (评审 N 条待评审的条目, "review the N items waiting for review") right after the assistant had replied often showed nothing until the first item had been reviewed, and a second click was refused. The button now greys out and 评审中 0/1 ("reviewing 0/1") appears as soon as the review starts.
- **Let the assistant fix this** (让助手照这条改) names the reviewer's suggestion first and the problem after it when the finding has a suggestion; before, it prefilled only the problem, which could read as the opposite of the suggested change.

### Word materials

- The text written beside each uploaded `.docx` for the assistant is now Markdown (`<name>.docx.md`) instead of plain text. Headings keep their level and Word's automatic numbering is written in front of them; list items use `-` or `1.`; tables are Markdown tables with one row per Word row, merged cells marked `（同左）` and `（同上）`, nested tables flattened into the outer cell; pictures are extracted to `<name>.docx.media/` and linked where they appear, on a line of their own when they stand in a heading; text-box text is written as a quote without a paragraph number and cannot be cited; the text inside equations is written in order as plain text. Every paragraph keeps its number, written `[pN]` in front of its text. The counting rule, the source form `inputs/a.docx#pN` and the verbatim check are unchanged.
- Word files in tasks created with 0.2 are still read: when a Word file has only the old `<name>.docx.txt`, the assistant, the excerpt check and the Materials tab read that file. Such files have no segment list on disk and no location table, so the Materials tab shows no sections for them and their source labels leave the chapter out. File names ending in `.docx.md` or `.docx.txt` are reserved.
- A segment list is written beside each Word material on upload (`<name>.docx.segments.json`): blocks at headings, each with its paragraph and line range. The list is recomputed when the `材料分段` parameters of the launch profile change. The assistant's skill tells it to read the list first, read long materials a few blocks at a time and save before reading on. The task status message states each Word material's paragraph and block count and, on a resumed session, how many paragraphs no item cites; `get_task_status` lists every block with the number of items citing it. The Materials tab shows the same per section under **按章节看引用** (sections and citations), greys sections no item cites, and scrolls to a section when it is clicked.
- The assistant's tool allowlist adds the built-in `grep` and `find`, so it can find paragraphs by words instead of reading from the top.
- A location table is written beside each Word material on upload (`<name>.docx.locations.json`): the headings by paragraph number, with the level and the heading text, the automatic number written as Word shows it (for example 第一章 总则). The chapter in a Word source label comes from this table; the chapter of a cited paragraph is the nearest heading at or before it, and a paragraph in a table cell that uses a heading style is not a chapter. The projection and the table take the heading text from the same code.
- Word headings that declare their level only through the style name are recognized. A paragraph's heading level comes from, in order: its own outline level; its style's outline level, looked up through the styles it is based on; the style name `heading N` or `标题 N`. Before, a file whose level-1 heading style carries no outline level (as LibreOffice writes it) lost all its level-1 headings, and the Materials tab put sources and citation counts under the wrong section.
- Derived files (projections, segment lists, location tables) are marked with `derived_from` in the materials API and are not listed or counted as materials in the pages. **View** on a Word file on the task page shows the file page by page in its original layout.
- When the Materials tab or **View** cannot draw a Word file, the page shows a fixed note instead of the rendering library's English error, and the hint about the original layout above the file is left out: 这份 Word 文件在这里显示不出来，但文件已经上传好了：助手仍然能读到它的内容，条目的来源仍然有效，不需要重新上传。 The library's error goes to the browser console. The source labels of such a file keep the file name and the chapter and leave out the page and the position on the page.
- Word files that could not be shown at all are now shown: a file with an equation whose brackets, bar or group character carried no properties, and a file whose automatic numbering is set in a paragraph style without a level.

### Uploading materials

- **Not backward compatible:** an upload whose name is taken by a material with other content is refused with `name_taken` (409) instead of being stored as `<name>-2.<ext>`. Names count as the same when they differ only in case, in Unicode normalization (NFC) or in white space at either end. Materials already stored under such names are left as they are.
- An upload whose bytes are the same as those of a material already in the task, whatever its name, is refused with `duplicate_content` (409). Both refusals give the existing material's path in `data.path`.
- `GET /api/v1/service` gives the upload rules: the size limit and its message (`upload.max_bytes`, `upload.too_large_text`), the extensions (`upload.extensions`), and the accepted types and the refusal written out for people (`upload.types_text`, `upload.unsupported_type_text`). The pages take the hints from there and refuse a file that is too large or of another type before sending it. Before, a file over 5 MB sent through the web development server showed 请求没有成功（HTTP 502）.

### Conversation and work view

- A turn the user stopped, or one that failed, says so. Under the summary line of such a turn an amber line reads 这一轮是你让助手停下的。 ("you stopped the assistant in this turn") with the revisions the turn saved and a tag that opens them, or 这一轮因为出错停下了，助手没有做完。 ("this turn stopped because of an error and the assistant did not finish"). The line stays after a reload; before, a stopped turn looked like a finished one and a failed turn disappeared from the conversation after a reload. A failed turn has its own notice, with the new `problem` code `failed`. `work_summary` carries `outcome` with the values of `work_ended`. The `outcome` of `work_ended` is decided by the turn's last assistant message, so a turn whose model call failed and was then retried successfully reports `replied` or `no_reply` instead of `failed`.
- The work summary no longer says a tool call finished when it has no result: a stopped save was shown as 写好并保存了修订 None：. A save or a completion that did not happen reads 保存修订没有做成 or 完成任务没有做成.
- Texts shown to people no longer write a missing value as None, in notices, in the generated document and in the revision log.
- Prefilled text is added after a draft already typed into the conversation input, on a new line, instead of replacing it.
- **Generate a document from this revision** (按此修订生成文档) on a revision card shows the revision it was clicked on; before, it showed the latest revision the first time it was used.
- The session menu in the work view reads the session list again when the assistant finishes a turn and when the menu is opened; before, it kept the last activity and message count from when the page was opened.
- The task page no longer shows **New session** (新建会话) once the task is completed or abandoned.
- When a message cannot be sent, its text goes back into the input box it came from if that box is still empty.

### When the assistant or the service is not available

- A direct operation on the page (saving or deleting an item, marking items read, undo, review and rule changes, keeping a wording) starts the assistant on demand and resumes the session first, as a message does. The work view no longer turns read-only when the assistant has exited: a note above the input box says it will restart on the next message. The page stays read-only only when the assistant cannot be started.
- Opening or reloading a session page while the assistant cannot be started shows its conversation, items and materials read-only, with the reason above the input box, instead of an error page. The snapshot is then answered with `executor.state` `failed_to_start` and the reason in `executor.text`, worded as in the `executor_state` event, instead of failing with `executor_unavailable`. Every reload tries to start the assistant again.
- Notices about the assistant's program no longer mention processes, commands or standard error, and they name pi only when the program cannot be found: 找不到助手的程序（pi），请检查安装。 ("the assistant's program (pi) cannot be found, check the installation"). When the system refuses to start it, the notice gives only the system's error code, for example 助手没有启动起来，系统原因：EACCES. The command and the system's own message go to the backend log and to the `detail` of the error.
- The note above the input box wraps long text inside the box. While the input box cannot be used, its placeholder says 现在不能在这里输入，原因见上方。 instead of repeating the note.
- The reconnecting notice says changes cannot be sent until the connection is back. After about a minute without a connection it becomes a lasting message that the service may have stopped, and the page retries every 30 seconds. A failed request says the service cannot be reached instead of mentioning the backend.
- The service tells open pages that it is stopping (`service_exiting`, with the run mode in `mode`) before it closes the event streams. Open work views then show that the service has exited or stopped, and stop reconnecting.
- Going back to an earlier session, or resuming one after the task service restarted, could put the assistant into a new, empty session without any error when the service was started with relative `--tasks` and `--runs` paths. The service now uses absolute paths, and after resuming or switching it checks that the assistant reports the requested session; if not, it sends nothing and answers `session_resume_failed`.

### Source checks

- A document source holds one continuous passage: for a Word file the excerpt must start in the cited paragraph and may run on into at most the next five. An excerpt that puts separate passages into one source is refused with a note to write one source per passage. Blank lines in an excerpt count as white space; before, passages separated by a blank line were saved as several sources, and such an excerpt is now refused.
- When an excerpt is not in the paragraph named by the source and occurs in several other paragraphs, the refusal lists the nearest ones with their table positions and asks the assistant to choose by context, instead of pointing to a single one. Pointing to one paragraph led the assistant to save sources that matched word for word but pointed to the wrong place.
- An excerpt taken from a text box in a Word file is refused with a note that text-box text cannot be cited.

### Task service in TypeScript

- `backend/`: the task service is rewritten in TypeScript and run directly by Node 24 with no third-party dependencies. `scripts/dev.sh` and `make dev` start it (`node backend/src/main.mts`). `--mode desktop|server` picks the default bind address; `GET /api/v1/service` reports the running mode, port and capabilities; a taken port falls back to the next free one.
- The earlier Python task service stays in `server/` for comparison and is no longer started by the scripts. Backend tests and `backend/compare/` compare with saved outputs of the Python service (`--against fixtures`). The launch profiles and the assistant's system prompt moved to `backend/profiles/` and `backend/prompts/`. The fake model endpoint used by tests has a TypeScript version in `backend/fake_model/`, and `observatory/archive-format.md` states the format of the archive files.
- `--web <directory>`: the task service serves the built web pages from that directory.
- When starting the assistant's program fails at once, the service closes the archive files of that start and leaves no empty ones behind.

### Packages

- `release/`: build scripts for a single executable (Linux and Windows) and a Linux AppImage. The packages carry the task service, the built web pages, the assistant's program and its extension, and the `rg` and `fd` programs that `grep` and `find` need. Starting a package opens the browser on the task list; starting it again while it runs only opens the browser. Data goes to `~/.local/share/taskwright/` on Linux and to `%LOCALAPPDATA%\Taskwright` on Windows, or to `TASKWRIGHT_DATA_DIR`.
- Desktop profile `desktop.json` for the packages. In desktop mode the task service uses the default provider and model from the assistant program's `settings.json` when both are set, checks at startup whether the model is registered or logged in, and reports the result in `GET /api/v1/service`. When no model service is set up the pages show a notice with a link to the deployment guide.
- In desktop mode the local-user menu has **Exit service** (退出服务), which asks for confirmation and then shows a service-stopped screen (`POST /api/v1/service/exit`; `capabilities.exit` in `GET /api/v1/service` is `true` only in desktop mode and for requests from this computer). This endpoint is meant for the 0.3 packages and may not stay.

### Observatory, simulator, scripts and documentation

- The observatory reads a `--runs` directory that holds the task archive directories again on every read, so tasks created after it started appear without a restart. Without `--workspaces` it picks the `tasks/` directory next to `runs/`, even while `runs/` holds no task yet.
- The simulator (`sim/`) no longer uses the Python task service. `python3 -m sim.run` starts the TypeScript task service, and the simulated user is started and driven by a Node driver (`sim/user_agent_driver.mts`) that uses the task service's session class. The judge checks the completion conditions through the observatory. Running the simulator needs Node.js, the assistant's program and a `python3` that can import the observatory package, but not the `server` package. When the simulated user cannot be started or its driver stops, `record.json` gives the stop reason 模拟用户不可用：<reason>.
- `scripts/tui.sh` opens the assistant program's own terminal interface for a task and replaces the Python `tui` client; the `chat` terminal client is no longer documented.
- `web/mock/`, the web mock server, is removed. The web development server proxies to the local task service, and `scripts/dev.sh --demo` starts the task service on the fake model with a demo task.
- `scripts/check-public.sh` also catches home paths written with a tilde and looks inside gzip-compressed files. `examples/library-lending/run.sh` runs from start to end again, and a backend test runs it.
- Documentation now matches the code in four places: withdrawing a confirmation does not make an item unread again; **Answer** (回答) on a question card stays available while the assistant works as long as its box is empty; a rule made required for the task can be switched off directly; the observatory's `--runs` takes the task service's `runs/` directory.

### Known issues

- Until the assistant's skill is updated, the assistant may try to complete the task without asking, or ask with a card that lacks the right option, and be refused once before it asks with the right card. Completing through the assistant can take an extra round; the green bar on the page is not affected.
- The Windows executable can be built with the same scripts but has not been verified.
- Upgrades do not yet promise that existing tasks keep working. Back up the task directories before upgrading.
- For a Word file that cannot be drawn, clicking a section under **按章节看引用** does not scroll, clicking a source label does nothing in the Materials tab, and the count of citing items next to the file name is not shown. The assistant's reading and the sources of the items are not affected.
- With the default profiles the assistant's program asks its vendor's site for its model catalog in the background each time it starts, with one request per built-in model provider (as of the version current at the time of writing). After it gets an answer for a provider it does not ask again for that provider for four hours. When the site cannot be reached, it asks again at the next start. The requests carry no task content. Setting `offline` under `flags` in the launch profile turns this off, and so does starting the task service or a package with the environment variable `PI_OFFLINE=1`.
- The earlier Python task service is still in the repository (`server/`), for comparison only, and will be removed in the next version. Its projection module is already removed, so it cannot project Word files.

## [0.2.0-alpha] - 2026-09-25

### Added

- Tool rejections are recorded in a `tool_rejection` table (tool, call id, unit of work, reason kind, fact and guidance, the first 2,000 characters of the input); the observatory shows them under the rejected call.
- Word materials: `.docx` files can be uploaded (up to 5 MB). The service writes a paragraph-numbered text beside each one (`<name>.docx.txt`) for the assistant; sources quoting a Word file name the paragraph (`inputs/a.docx#p37`), and `save_revision` checks the excerpt against that paragraph, or against it and at most five following paragraphs.
- The material pane shows Word files page by page in their original layout, with headers and footers; each Word source is labelled with its page, section and position on the page, derived from the paragraph number. Clicking a source highlights the quote, marks a quote that runs over several paragraphs, or says where it was not found.
- `GET …/materials/raw` returns a material file as uploaded.

- Review gate: each reviewed collection names a rule file (`docs/review-rules/*.json`) with numbered rules marked required or optional; the domain-knowledge documents quote the rules through generated regions (`scripts/render-rules.mjs`).
- The user starts a review from the interface ("Review N items waiting for review", "Review this item", "Review these N" in the completion panel). The review runs in the background and reports progress through two new events, `review_progress` and `review_finished`.
- Every finding cites a rule number. Findings under required rules are problems and fail the item; findings under optional rules are advice and do not. The verdict is computed from the rule levels, not taken from the reviewer's output.
- Findings are shown next to their fields in two colours, with the rule text on demand and a button that prefills a request to the assistant.
- The `request_review` tool is enabled for the assistant, for use only when the user asks for a review in the conversation.
- A Review tab in the side panel lists every review ("review N") with its counts, the findings of each item and whether each finding was fixed in a later revision, kept, or is still open.
- Keeping a wording that failed review, with an optional reason (`waive_review`, `unwaive_review`); a kept item counts as passed until it changes.
- Per-task rule switches: optional rules can be switched off or made required (`set_review_rules`). Each review records the rule fingerprint, and items go back to waiting for review when the rules change.
- The reviewer sees the full materials when they are short (up to 20,000 characters), otherwise the paragraphs its sources quote. Reviewer calls ask for temperature 0.
- Events `review_batch`, `review_waived`, `review_unwaived`, `review_rules_changed`.

- One service per task: a running service marks each task it serves with `service.lock` (port, process id, start time, host) and removes it on exit. Another service lists such a task as in use and refuses it (`task_occupied`); a lock left by a process that is gone is replaced.
- The service passes its task root to pi (`TASKWRIGHT_TASKS_ROOT`), and every write refuses a task database outside it.

### Changed

- `save_revision` is idempotent per tool-call id: a replayed call writes nothing and returns the first result.
- The basis of a suggested value is checked verbatim like a `save_revision` source, including Word paragraphs and domain notes.
- Reviewing an item whose content and rules have not changed since its last review needs an explicit "review again".
- When a review ends, the conversation shows one sentence with the counts; the findings are in the Review tab and in the task status.
- EARS-R2 and EARS-R3 state that a named system is a valid subject and that counting words such as "books" or "days" are units.
- "Every item passed review" is reported in three groups: items not reviewed yet, items that failed, and items that failed but whose wording you kept.
- `review_finding` gains `rule_id` and `level`, and `review` gains `batch_id`, `rules_hash`, `reviewer_version` and `forced`; older databases get the columns (and the new `review_waiver` table) when first opened for writing.

- Resuming a session whose file records another task directory (a copied or moved task) rewrites that record to the service's own task directory, keeping the original file as a backup, so writes never go back to the original task data.
- `save_revision` rejections have two layers: the fact (what was tried and why it is not allowed) and the guidance for the assistant. Work summaries show only the fact, for example "保存修订被拒：助手想改 TBD-001 的「种类」，但问题条目写下后只能改状态与处理结果。"
- The reply heading says 助手 (assistant) instead of 执行者.

### Removed

- The development switch `TASKWRIGHT_DEV_REVIEW_AS_MET`, and the stop after three failed reviews of the same revision.
- Open questions follow the items they concern: list rows show how many unresolved questions point at an item, the item detail lists those questions with an answer box and a keep-pending button, and following a question's link to an item offers a way back to the question list.

## [0.1.0-alpha] - Unreleased

First public release.

### Added

- Task type for writing a software requirements specification (`task-types/srs-authoring`).
- Agent built on pi, limited to eight tools; it changes the deliverable only through `save_revision`.
- A platform skill shared by all task types, separate from each task type's own skill.
- Direct operations in the interface: edit, delete, confirm, withdraw a confirmation, keep pending, undo a revision.
- One revision sequence per task; every item is identified by its id and a revision number.
- Web interface with a Revisions tab, field-level change marks since the last confirmation, and adjustable font size.
- One writer at a time and strict turn-taking between the user and the agent.
- Markdown documents generated from a chosen revision, with readable sources.
- HTTP/SSE task service, terminal client, read-only observatory, and a simulated user for test runs.
- Documentation in English and Chinese, and a GitHub Actions workflow for checks and tests.

[0.3.0-alpha]: https://github.com/netbuddy/taskwright/releases/tag/v0.3.0-alpha
[0.1.0-alpha]: https://github.com/netbuddy/taskwright/releases/tag/v0.1.0-alpha
