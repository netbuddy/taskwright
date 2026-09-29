# Roadmap

Planned themes for the next releases. No dates; order and scope may change.

## 0.2 Dialogue, review and materials

- [x] Review gate: the assistant checks items against the domain rules before asking for confirmation; results are recorded, and the user can keep a rejected wording with a reason
- [x] Dialogue understanding: the assistant writes down how it read each message before acting; follow-ups and changes of mind are handled as facts
- [x] Issues attached to items: an issue is shown on the item it concerns, and the item list can filter items with issues
- [x] Word materials shown as-is: .docx rendered with its original layout, sources located and highlighted by paragraph
- [x] Find a session in the observatory by task name or session name; statistics counted per run

## 0.3 One runtime and materials

- [x] Task service rewritten in TypeScript, run by Node with no third-party dependencies
- [x] Single executable without a window that opens the interface in the browser: Linux (AppImage and plain executable). A Windows executable can be built from the same scripts but has not been verified yet
- [x] Word materials as Markdown for the assistant, with headings, automatic numbering, tables and pictures; sources name the chapter from a location table
- [x] Material segmentation and lexical search
- [x] Uploaded materials cannot repeat the content or the name of a material already in the task
- [x] Reviews decided by one shared rule: once per revision and rule set, kept wordings counted apart

## 0.4 Materials and retrieval

- [ ] Fixes for the issues found in the 0.3 trial runs that were not fixed in 0.3
- [ ] Word materials shown as PDF, so that pages match what Word shows
- [ ] PDF materials
- [ ] Semantic search over materials (vector retrieval)
- [ ] Delete and replace materials
- [x] Remove the earlier Python task service

## 0.5 Several users

- [ ] Authentication and multiple users
- [ ] Stop a run in progress from the interface
- [ ] Abandon a task

## 0.6 Deliverables and desktop

- [ ] Word (.docx) export
- [ ] Cross-item review: duplicates, conflicts, inconsistent wording
- [ ] Desktop application based on Electron
- [ ] Upgrades that keep existing tasks
- [ ] Baselines of the whole deliverable
- [ ] Browse past tasks

## 0.7 Long sessions

- [ ] Resume correctly after a session has been compacted
- [ ] Recover after a crash

## 0.8 Task orchestration

- [ ] Nested tasks
- [ ] Subtasks run one after another
- [ ] A second task type: document writing
- [ ] Read-only requirements pool shared across tasks

## 0.9 Practice runs

- [ ] Simulated user as a product feature: choose a persona, run a practice session, read the verdicts and the judge's report
- [ ] Observatory replay of what the user saw
- [ ] Secret management
