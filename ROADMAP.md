# Roadmap

Planned themes for the next releases. No dates; order and scope may change.

## 0.2 Dialogue, review and materials

- [ ] Review gate: the assistant checks items against the domain rules before asking for confirmation; results are recorded, and the user can keep a rejected wording with a reason
- [ ] Dialogue understanding: the assistant writes down how it read each message before acting; follow-ups and changes of mind are handled as facts
- [ ] Issues attached to items: an issue is shown on the item it concerns, and the item list can filter items with issues
- [ ] Word materials shown as-is: .docx rendered with its original layout, sources located and highlighted by paragraph
- [ ] Find a session in the observatory by task name or session name; statistics counted per run

## 0.3 One runtime and retrieval

- [ ] Task service rewritten in TypeScript
- [ ] Single executable without a window (AppImage, exe) that opens the interface in the browser
- [ ] Material segmentation and retrieval (lexical first, then vector)

## 0.4 Practice runs

- [ ] Simulated user as a product feature: choose a persona, run a practice session, read the verdicts and the judge's report
- [ ] Cross-item review: duplicates, conflicts, inconsistent wording
- [ ] Observatory replay of what the user saw

## 0.5 Long sessions

- [ ] Resume correctly after a session has been compacted
- [ ] Recover after a crash
- [ ] Stop a run in progress
- [ ] Abandon a task

## 0.6 Task orchestration

- [ ] Nested tasks
- [ ] Subtasks run one after another
- [ ] A second task type: document writing
- [ ] Read-only requirements pool shared across tasks

## 0.7 Deliverables

- [ ] Baselines of the whole deliverable
- [ ] Browse past tasks
- [ ] Word (.docx) export

## 0.8 Desktop and deployment

- [ ] Desktop application based on Electron
- [ ] Authentication and multiple users
- [ ] Secret management
- [ ] Upgrades with migration of existing tasks
