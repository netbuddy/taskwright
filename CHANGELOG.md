# Changelog

## 0.1.0-alpha

First public release.

- **Task type: software requirements specification** (`task-types/srs-authoring`): four collections (use cases, non-functional requirements, constraints, open issues), the agent's skill, domain rules for use cases and EARS statements, and a document template.
- **Agent tools** (loaded into pi): save a revision (batched add, update, delete, each item with field-level sources), reply to the user (structured replies with at most one closing action: ask, confirm, suggest, choose, or propose), view an item, query task status, record a user confirmation (decided by a separate confirmation reader), and complete the task (only when every completion condition holds).
- **Direct user operations** through extension commands: edit fields, delete, confirm, withdraw confirmation, keep an open issue pending, and undo a revision, with version checks.
- **Three ways to work with a task**: the web interface, a terminal client, and pi's own terminal UI.
- **HTTP/SSE task service**: tasks, sessions, snapshot, event stream with replay, messages, direct operations, materials, document preview and download.
- **Observatory**: a read-only web app showing sessions, runs, turns, tool calls, the deliverable board, system health, and a concept glossary; optional links into Langfuse.
- **Simulation**: a simulated user that drives the agent through the same API, a batch runner, and a two-layer judge; an example persona that matches the library-lending example.
