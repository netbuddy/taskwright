# Architecture

> For contributors who change the code. What the product can do is described in [capabilities.md](capabilities.md); how to run it is in [deployment.md](deployment.md).

## Components

| Component | Language | Runs where | Reads the task database | Writes the task database |
|---|---|---|---|---|
| Agent (`agent/`) | TypeScript | inside the pi process | yes | **yes, the only writer** |
| Server (`server/`) | Python | its own process; starts one pi process per task | read-only | never |
| Observatory (`observatory/`) | Python | its own local web app | read-only | never |
| Web (`web/`) | TypeScript, React | the browser | no, it only calls the API | never |
| Simulator (`sim/`) | TypeScript tools, Python driver | a second pi process | read-only (for judging) | never |

**The three kinds of code.**

| Kind | Where | What it may do |
|---|---|---|
| Tools and extension commands | `agent/src/tools`, `agent/src/hooks` | Validate and write the task database, always through the core functions in `agent/src/lib`, one transaction and one event per write. |
| Backend | `server/`, `observatory/` | Start and supervise pi, forward what the user says, relay events, read the database read-only. Never interpret or grade content. |
| Frontend | `web/` | Send requests; change the screen only when the corresponding event arrives. |

## Roles

| Role | Who | What it does |
|---|---|---|
| User | a person in the web interface or a terminal, or the simulator | Supplies materials, answers questions, edits and confirms items. |
| Executor | the agent inside pi, following the platform skill and the task type's skill | Reads materials, writes items with sources, asks about what is unclear, replies through the reply tool. |
| Judges | model calls made inside tools, with no tools of their own | The reviewer checks one item against the numbered review rules of its collection; the user starts it from the interface, and the code computes the verdict from the rule levels of the findings. Whether the user accepts an item is not judged by a model: opening the item counts as reading and confirming it. |

## Data flow

1. The user creates a task (task type, name, materials). The server copies the task type's starting files into a new task directory, and the agent's command-line entry point creates the database and the task record.
2. Opening a session starts pi in that directory. An extension appends a task-status message that lists the materials.
3. The user's words go to pi. The executor calls tools; each save becomes one revision of the deliverable (the changed items' content at that revision) plus one row in the `event` table.
4. The server notices new events (after write tools finish, after extension commands report back, and by polling every 2 seconds while pi runs), reads them in a short read transaction, and pushes them to the browser over SSE, together with conversation and progress events.
5. Direct operations in the web interface (edit, confirm, undo, …) go through extension commands inside pi, so they use exactly the same write path as the tools.
6. Generating a document renders the deliverable as of one revision (optionally only some items) through the task type's template. No model is involved.

**Event stream in one sentence:** every database event has a monotonically increasing sequence number, the browser applies each number once and asks for a fresh snapshot when it detects a gap, and conversation and progress events carry no number and are rebuilt from the snapshot after a reload.

## Database tables (`task.sqlite`, one task per task directory)

| Table | One row is |
|---|---|
| `task` | the task: task definition path and snapshot, name, domain tag, status (in progress, completed, abandoned), who created it. |
| `revision` | one batch of changes (one save-revision call or one direct operation). |
| `item` | an item's identity: its id (for example `UC-001`), collection, and the revisions that added or deleted it. |
| `item_version` | an item's fields at one revision; an item has a row only for the revisions that added, changed or restored it. |
| `item_source` | one place a source supports in an item at one revision: kind (document excerpt, user's words, added by the agent, direct user edit), locator, verbatim excerpt, field and list index. |
| `review` | a reviewer's verdict on an item at one revision; its findings, each with the rule number and level, are in `review_finding`. |
| `judgement` | one confirmation mark (the table keeps its early name): its basis, read (the user opened the item), interface edit, or interface click (a withdrawal); older databases may also hold marks recorded from the user's words. |
| `judgement_item` | which items, each at one revision, one mark accepted (read or confirmed) or rejected (withdrawn). |
| `event` | one thing that happened, with the pi session id, tool-call id and actor (executor or user). Every write adds exactly one. |
| `model_call` | one model call made by a judge: prompt, raw output, model, duration, usage. A process record, not a domain fact. |

The database uses SQLite in WAL mode with a 5-second busy timeout: reads never block writes, and writes queue.

## Three rules the code keeps

1. Writes happen only in the agent's tools and extension commands, through one set of core functions.
2. Validation checks structure only: collections, fields, types, required fields, sources. No content keyword lists; judging content is a model role.
3. The interface shows what the event stream says happened, never what it expects to happen.

[中文版](architecture.zh-CN.md)
