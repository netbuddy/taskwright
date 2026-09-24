# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- Reviewing an item whose content and rules have not changed since its last review needs an explicit "review again".
- When a review ends, the conversation shows one sentence with the counts; the findings are in the Review tab and in the task status.
- EARS-R2 and EARS-R3 state that a named system is a valid subject and that counting words such as "books" or "days" are units.
- "Every item passed review" is reported in three groups: items not reviewed yet, items that failed, and items that failed but whose wording you kept.
- `review_finding` gains `rule_id` and `level`, and `review` gains `batch_id`, `rules_hash`, `reviewer_version` and `forced`; older databases get the columns (and the new `review_waiver` table) when first opened for writing.

### Removed

- The development switch `TASKWRIGHT_DEV_REVIEW_AS_MET`, and the stop after three failed reviews of the same revision.

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
