# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Word materials: the text written beside each uploaded `.docx` for the assistant is now Markdown (`<name>.docx.md`). Headings keep their level (`#` to `######`) and Word's automatic numbering is written in front of them; list items use `-` or `1.`; tables are Markdown tables with one row per Word row, merged cells marked `（同左）` and `（同上）`, and nested tables flattened into the outer cell; pictures are extracted to `<name>.docx.media/` and linked where they appear; text-box text is written as a quote without a paragraph number. Every paragraph keeps its number, written `[pN]` in front of its text, and the counting rule, the source form `inputs/a.docx#pN` and the excerpt check are unchanged. Empty paragraphs are not written but still counted.
- The projection is written by one TypeScript module (`agent/src/lib/docx_markdown.ts`, command-line entry `agent/src/cli/docx_projection.mts`); the service calls it for uploads and for `create_task --material`. The Python projection module is removed.
- The material list marks each projection with `derived_from` (the path of its `.docx`); the task page and the material pane leave those entries out and do not count them, and **View** on a Word file on the task page shows the file page by page in its original layout instead of the projection text.
- Tasks created with 0.2 keep working: when a Word file has only the old `<name>.docx.txt`, the assistant, the excerpt check and the material pane read that file. File names ending in `.docx.md` or `.docx.txt` are reserved.

### Fixed

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
