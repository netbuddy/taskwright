# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Word materials get a segment list next to the projection (`<name>.docx.segments.json`): blocks at headings, each with its paragraph and line range, written on upload and recomputed when the `材料分段` parameters of the startup profile change. The task status message states each Word material's paragraph and block count and, on a resumed session, how many paragraphs no item cites; `get_task_status` lists every block with the number of items citing it. The material pane shows the same per section, greys sections no item cites, and scrolls to a section when it is clicked.
- The assistant's tool allowlist adds pi's built-in `grep` and `find`; the platform skill tells it to read the segment list first, read long materials a few blocks at a time and save before reading on, and find paragraphs with `grep`.
- `release/`: build scripts for a single executable (Node SEA, Linux and Windows) and a Linux AppImage, with a measurement script. The packages carry the TypeScript backend, the built web pages, the assistant's extension and the `rg` and `fd` programs that `grep` and `find` need, so they work without a network connection. Starting a package opens the browser on the task list; starting it again while it runs only opens the browser. Data goes to `~/.local/share/taskwright/` or to `TASKWRIGHT_DATA_DIR`.
- `--web <directory>`: the backend serves the built web pages from that directory and answers unknown paths with the start page; without the option nothing changes.
- Desktop profile `desktop.json` for the packages. In desktop mode the backend uses the default provider and model from pi's `settings.json` when both are set, checks at startup whether the model is registered or logged in, and reports the result in `GET /api/v1/service`. When no model service is set up the pages show a plain-language notice with a link to the deployment guide; in desktop mode the local-user menu has **Exit service**, which asks for confirmation and then shows a service-stopped screen.
- `backend/`: a TypeScript rewrite of the task service, run directly by Node 24 with no third-party dependencies, alongside the Python service. It serves the read side, task creation, material upload with the Markdown projection in process, the occupancy lock, the pi subprocess over RPC with the three archive files, the executor watch, and the event stream with replay. Direct operations, card clicks and stop go through the same extension commands as the Python service; a dual-run comparison of eleven session scenarios against the Python service shows the same responses, events and archives. `--mode desktop|server` picks the default bind address; `GET /api/v1/service` reports the running mode, port and capabilities; in desktop mode `POST /api/v1/service/exit` (loopback only) shuts the service down after closing each task's pi; a taken port falls back to the next free one. The fake model endpoint used by tests has a TypeScript version in `backend/fake_model/`. `backend/compare/` runs the same operations against both services and diffs responses, events and archives; `observatory/archive-format.md` states the archive contract.

### Changed

- A direct operation for a session (saving or deleting an item, marking items read, undo, review and rule changes, keeping a wording) now starts the assistant on demand when it is not running and resumes that session first, as a message does; before, it failed until the assistant had been started again. The work view no longer turns read-only when the assistant has exited: a blue note above the input box says it will restart on the next message, and while it starts the send button waits. The note also shows when the service could not resume the session after a restart. The page stays read-only only when the assistant cannot be started.
- The service tells open event streams that it is stopping (`service_exiting`, with the run mode) before it closes them, whether it is stopped from the page, by SIGINT or SIGTERM, or by closing its window. Open work views then show that the service has exited (desktop) or stopped and can be refreshed once back (server), and stop reconnecting; earlier notices are cleared.
- Notices about the agent program no longer mention pi, processes or commands: 助手的程序在 N 秒内没有回应。 (N is the actual time limit), 助手的程序拒绝了这次操作：…, 助手的程序退出了, and 找不到助手的程序（pi），请检查安装。 when starting it fails because the program file is not there. The command and the system's own message still go to the backend log and to the `detail` of the error.
- `GET /api/v1/service` gives the file extensions that can be uploaded (`upload.extensions`); the file choosers on the task page and in the conversation and the upload hint take them from there, and leave them out until the service information has arrived.
- `scripts/dev.sh` and `make dev` start the TypeScript task service (`node backend/src/main.mts`) instead of the Python one. The launch profiles and the assistant's system prompt moved to `backend/profiles/` and `backend/prompts/`. `scripts/tui.sh` opens pi's own terminal interface for a task and replaces the Python `tui` client; the `chat` terminal client is no longer documented. Backend tests and the comparison scripts compare with saved outputs of the Python service (`--against fixtures`) instead of running it. `scripts/check-public.sh` also catches home paths written with a tilde and looks inside gzip-compressed files.
- A document source holds one continuous passage: for a Word file the excerpt must start in the cited paragraph and may run on into at most the next five, and blank lines count as white space. An excerpt that puts separate passages into one source is refused with a note to write one source per passage; the check no longer splits excerpts at blank lines or looks for where the later parts are.
- Word materials are projected to Markdown (`<name>.docx.md`) instead of plain text: heading levels, automatic numbering, tables as Markdown rows, pictures as links to files extracted next to the material, text boxes as quoted lines that cannot be cited. Paragraph anchors `[pN]` and the verbatim source checks are unchanged; older `.docx.txt` projections are still read.
- Derived files (projections) are no longer listed as materials in the web interface; the task page previews a Word file in its original layout. The materials API marks derived files with `derived_from`.
- When an excerpt occurs in several paragraphs, the rejection lists the nearest ones with their table positions instead of naming a single paragraph; a text-box excerpt is rejected as such.

### Changed

- Word materials: the text written beside each uploaded `.docx` for the assistant is now Markdown (`<name>.docx.md`). Headings keep their level (`#` to `######`) and Word's automatic numbering is written in front of them; list items use `-` or `1.`; tables are Markdown tables with one row per Word row, merged cells marked `（同左）` and `（同上）`, and nested tables flattened into the outer cell; pictures are extracted to `<name>.docx.media/` and linked where they appear; text-box text is written as a quote without a paragraph number. Every paragraph keeps its number, written `[pN]` in front of its text, and the counting rule, the source form `inputs/a.docx#pN` and the excerpt check are unchanged. Empty paragraphs are not written but still counted.
- The projection is written by one TypeScript module (`agent/src/lib/docx_markdown.ts`, command-line entry `agent/src/cli/docx_projection.mts`); the service calls it for uploads and for `create_task --material`. The Python projection module is removed.
- The material list marks each projection with `derived_from` (the path of its `.docx`); the task page and the material pane leave those entries out and do not count them, and **View** on a Word file on the task page shows the file page by page in its original layout instead of the projection text.
- Tasks created with 0.2 keep working: when a Word file has only the old `<name>.docx.txt`, the assistant, the excerpt check and the material pane read that file. File names ending in `.docx.md` or `.docx.txt` are reserved.

### Removed

- `web/mock/`: the web mock server and the script that exported a trial archive for it. They no longer matched the API and nothing used them. The web development server now proxies to the local task service (`http://127.0.0.1:8790`) by default, and `scripts/dev.sh --demo` starts the task service on the fake model with a demo task from `examples/library-lending/`; `web/README.md` describes how to reproduce the three situations the mock server had switches for with the real task service.

### Fixed

- `capabilities.exit` in `GET /api/v1/service` is `true` only for requests from this computer, so a page opened from another computer no longer offers an **Exit service** that the service would then refuse.
- The reconnecting notice no longer says you can keep working as usual: it says changes cannot be sent until the connection is back. After about a minute without a connection it becomes a lasting message that the service may have stopped, and the page retries every 30 seconds. A failed request says the service cannot be reached instead of mentioning the backend.
- The upload box on the task page no longer states a fixed size limit: the size comes from `upload.max_bytes` in `GET /api/v1/service`, written as in the task service's own message, and is left out until the service information has arrived.
- Texts shown to people no longer write a missing value as None. When pi gives no retry number, the notice says 模型服务暂时不可用，正在重试。. When the agent's program exits without an exit code, the notice at the top of the page says 助手的程序已经退出（退出码未知）。 and leaves out the error part when there is none; it no longer mentions pi, processes or standard error. A task occupied by a service whose lock names no host leaves the host out, and the logs leave out a missing port, host or process id. For damaged task data the document writes an empty list entry as （空） and leaves out a source's quotation when it has no excerpt, item titles skip empty list entries, and the revision log says 你撤销了一次修订 when an undo lacks the revision number. A launch profile extension without `source` is reported as 现在没有写.
- Uploading a file over 5 MB from the pages showed 请求没有成功（HTTP 502） when the pages came through the web development server: its proxy asks the task service to close the connection after answering, the service answers 413 without reading the oversized body, and the proxy, still sending the body, fails and answers 502. `GET /api/v1/service` now gives the upload limit and the message (`upload.max_bytes`, `upload.too_large_text`), and the task page and the conversation's attachment button refuse a larger file before sending it, with 单个文件不能超过 5 MB。. The task service itself still refuses oversized uploads without reading them.
- The work summary no longer says a tool call finished when it has no result, as when the assistant is stopped while it is still writing a call: a stopped save was shown as 写好并保存了修订 None：. Saving and completing the task are looked up in the task database by call id: when the revision or the completion is there, the summary says so; when it is not, it says 保存修订没有做成 or 完成任务没有做成, and 没有做完 when the database cannot be checked. Other tools use their existing wording for a call that did not succeed. The live steps of a stopped piece of work show the same line as the summary.
- `examples/library-lending/run.sh` step 6 read a field that no longer exists (`version_no`) and sent a `selection` the document endpoint ignores; it now asks for the latest revision of the whole deliverable and shows how to name a revision and items. A backend test runs the script from start to end on the fake model.
- Going back to an earlier session, or resuming one after the task service restarted, could put the assistant into a new, empty session without any error: the next message, the revisions it led to and the conversation went into a session the page did not show. This happened when the service was started with relative `--tasks` and `--runs` paths, because the service handed pi session file paths relative to its own working directory and pi, which runs in the task directory, did not find the file and silently opened a new session. The service now turns both directories into absolute paths and hands pi absolute session file paths. After resuming or switching it also checks that pi reports the requested session; if not, it stops pi, sends nothing, and answers `session_resume_failed` (the page shows 没能接上这条会话。请再试一次；如果还是不行，请把这个页面的地址告诉管理员。). When a message cannot be sent, its text now goes back into the input box it came from if that box is still empty.
- Word headings that declare their level only through the style name are recognized. A paragraph's heading level now comes from, in order: its own outline level; its style's outline level, looked up through the styles it is based on; the style name `heading N` or `标题 N` (N from 1 to 9, any case, the space optional; the style ID when the style has no name), also looked up through the base styles. Outline level 9 (body text) means not a heading. Before, only outline levels were read, so a file whose level-1 heading style carries no outline level (as LibreOffice writes it) lost all its level-1 headings: the projection wrote them without `#`, the segment list did not split at them, and the material pane put sources and citation counts under the wrong section. The projection and the material pane use the same rule. Projections and segment lists of files uploaded earlier are not rewritten; the material pane applies the rule at once.
- An excerpt taken from a text box in a Word file is refused with a note that text-box text cannot be cited.
- When an excerpt from a Word file is not in the paragraph named by the source and occurs in several other paragraphs (short table cells such as a single number do), `save_revision` and the reply basis check no longer point to one of them; they list the nearest ones with their table positions and ask the assistant to choose by context. Pointing to a single paragraph led the assistant to save sources that matched word for word but pointed to the wrong place.

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

[0.1.0-alpha]: https://github.com/netbuddy/taskwright/releases/tag/v0.1.0-alpha
