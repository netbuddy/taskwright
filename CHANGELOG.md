# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
