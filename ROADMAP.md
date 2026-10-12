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

## 0.4.3 PDF materials and replacing a material

- [x] PDF materials and knowledge base documents
- [x] Replace a material
- [x] The task status note at the top of a conversation folded into one line

## 0.5 Working in stages on a business description

How does the assistant get from materials to requirements without guessing?

- [x] Work in six stages, each entered by the user's click on a card the assistant proposes
- [x] A business description in seven chapters, with five standard models drawn from it
- [x] Questions recorded where they arise and settled with where the answer went
- [x] A document generated in the chapters of the business description, downloadable as a Word file of the whole document
- [x] Evaluation runs that compare the assistant before and after a change to its instructions
- [x] Upgrades that keep existing tasks; export and import of tasks and knowledge libraries; stopping a run from the interface

## 0.6 The life of a task

What happens to a task after its first document?

- [ ] Tasks, activities and flows: a task stays open after publishing a version, activities can run on their own or as nodes of a flow, the seven basic capabilities, and a change flow on top of a published version
- [ ] Publishing a version in place of completing the task; a version records which revision of which items it contains
- [ ] Browse past tasks and versions

## 0.7 Several users at once

Who may see and change what, and how many can work at the same time?

- [ ] Authentication, owners and permissions
- [ ] Limits on how many assistants run at once, with idle shutdown and a queue
- [ ] Backup and restore of tasks
- [ ] Load test with tens of users at once

## 0.8 More than one format of specification

Can the same understanding be written out in different forms?

- [ ] Separating the business description from the specification format: one business description, several item formats (use case tables, user stories)
- [ ] A second task type: document writing
- [ ] Read-only requirements pool shared across tasks

## 0.9 The assistant's quality

How good is what the assistant writes, and how do we know?

- [ ] Review rules verified on real projects
- [ ] Cross-item review: duplicates, conflicts, inconsistent wording
- [ ] One round of evaluation and improvement for the assistant's known faults: missed content, contradictions written as settled rules, one rule written twice
- [ ] Simulated user as a product feature: choose a persona, run a practice session, read the verdicts and the judge's report
- [ ] Observatory replay of what the user saw

## 1.0 First public release

Is it robust enough to hand to people we do not know?

- [ ] Resume correctly after a session has been compacted; recover after a crash
- [ ] Desktop application based on Electron
- [ ] Screenshots in the tutorial brought up to date
- [ ] Secret management

## 1.1 Task orchestration

Can one task be made of others?

- [ ] Nested tasks
- [ ] Subtasks run one after another

## Small fixes that ride along with a release

- [ ] Search of materials by meaning
- [ ] A source that cites a knowledge base document says so when the document has been replaced
- [ ] One name, 请过目, for the card that asks the user to look at items, in the assistant's instructions and in the simulator
- [ ] The four places that still say 先不管: the third option of the card that asks whether a question is resolved, the sentence sent for the user, the note left in the conversation, the operation names in the Revisions tab
- [ ] A shorter shared part of the stage instructions
- [ ] Fetch session entries from the assistant process only when they have changed
