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

## 0.4.0 Closing what 0.3 left open

- [x] Fixes for the issues found in the 0.3 trial runs that were not fixed in 0.3
- [x] Remove the earlier Python task service
- [x] Review tab laid out by what needs your attention; the reviewer sees the task's other items; unverified review rules are off by default
- [x] Items cite only original passages; your own edits add no source

## 0.4.1 Knowledge base, search and model configuration

- [x] Knowledge base: reference documents kept outside any task, chosen per task; the assistant looks rules up in them and cites the source text verbatim
- [x] Knowledge base search by meaning and by keyword
- [x] Model services and the models in use set up on a settings page
- [x] The assistant's program is pi 1.0.4, packaged from a lock file; no network access at startup

## 0.4.2 Sources, diagrams and Word export

- [x] Sources name the element of the task an item rests on: an item can cite any other item, and a basis changed or deleted afterwards is marked
- [x] Diagrams: the assistant draws use case, class, state and sequence diagrams and flowcharts as Mermaid text, checked before they are saved; a diagrams tab in the work view shows them, lets you move, scale and change them, and exports PNG
- [x] Export chosen items to Word: tick items in the list and download a .docx in which each item is a table, to paste into your own specification

## 0.4.3 PDF

- [ ] PDF materials and knowledge base documents (the parsing module is on the main branch)
- [ ] Word materials shown as PDF, so that pages match what Word shows
- [ ] Replace a material

## 0.5 Several users

- [ ] Search of materials by meaning
- [ ] Authentication and multiple users
- [ ] Stop a run in progress from the interface
- [ ] Abandon a task
- [ ] Limits on how many assistants run at once, with idle shutdown and a queue
- [ ] Upgrades that keep existing tasks

## 0.6 First public release

- [ ] Backup and restore of tasks
- [ ] Review rules verified on real projects
- [ ] One round of evaluation and improvement for the assistant's known faults: missed content, contradictions written as settled rules, one rule written twice
- [ ] Load test with tens of users at once
- [ ] Screenshots in the tutorial brought up to date

## 0.7 Deliverables and desktop

- [ ] Word (.docx) export of the whole deliverable
- [ ] Cross-item review: duplicates, conflicts, inconsistent wording
- [ ] Desktop application based on Electron
- [ ] Baselines of the whole deliverable
- [ ] Browse past tasks

## 0.8 Long sessions

- [ ] Resume correctly after a session has been compacted
- [ ] Recover after a crash

## 0.9 Task orchestration

- [ ] Nested tasks
- [ ] Subtasks run one after another
- [ ] A second task type: document writing
- [ ] Read-only requirements pool shared across tasks

## 1.0 Practice runs

- [ ] Simulated user as a product feature: choose a persona, run a practice session, read the verdicts and the judge's report
- [ ] Observatory replay of what the user saw
- [ ] Secret management
