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

### Changed

- "Every item passed review" is reported in two groups: items not reviewed yet and items that failed.
- `review_finding` gains `rule_id` and `level`; databases created by 0.1 get the columns when first opened for writing.

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
