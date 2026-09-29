# Saved outputs of the Python task service, for the comparison scripts

`compare.mts` (47 read-side steps) and `sessions.mts` (11 session scenarios) were written to run the Python and the TypeScript
task service side by side and compare their normalized outputs. The Python version is being removed, so its normalized output
is kept here, and both scripts can compare the TypeScript version against it with `--against fixtures`.

| File | Written by | Read by |
|---|---|---|
| `http_47.json` | `compare.mts … --save-fixture` (both versions running) | `compare.mts --against fixtures --b … --b-tasks … --b-runs …` |
| `sessions/<scenario>.json.gz` | `sessions.mts --work <empty dir> --save-fixtures` (both versions running) | `sessions.mts --against fixtures --work <empty dir>` |

The session outputs are gzip-compressed JSON (about 290 KB for all eleven, 3.4 MB uncompressed). To look at one:

```
node -e 'process.stdout.write(require("zlib").gunzipSync(require("fs").readFileSync(process.argv[1])))' backend/compare/fixtures/sessions/service.json.gz
```

Every file has a `source` entry: the commit of the last change to `server/` when it was generated, the date and the command.
The outputs are already normalized (ids, times, paths and ports replaced by placeholders, as described at the top of each script),
so they contain nothing specific to the machine they were generated on.

These files are temporary. They will be deleted once the scenarios are rewritten as integration tests that assert facts
(what was written to the database, which events arrived) instead of matching an older implementation's output.
They can only be regenerated while `server/` is still in the repository.

## Known differences from the saved outputs

The TypeScript task service has since changed on purpose in several ways the Python one has not. The saved outputs are not
regenerated for these changes, so `sessions.mts --against fixtures` reports the twenty-seven parts below as different, and only these
(besides values that differ only by the port the fake model endpoint listened on). All of them go away when the Python version
and these saved outputs are retired.

| Scenario and part | What differs | Why |
|---|---|---|
| `isolation`, event stream | The TypeScript side has one more event at the end of the first task's stream: `service_exiting` with `mode: "server"`. | The service now tells open event streams that it is exiting before it closes them, so pages can say so instead of reconnecting. This scenario stops the service while a stream is open. |
| `rpc`, observations | Step 12, a direct action sent after a restart before the session is opened (an empty `mark_viewed`), is answered 400 `bad_request` ("targets 应当是一个不为空的列表。") instead of 503 `executor_unavailable`. | A direct action now starts the assistant on demand and resumes the page's session, as a message does, and only then is the action itself checked. |
| `rpc`, archives | The raw event stream, the backend notes and the session file have the assistant start one step earlier (122 differences in the latest run). | Same change: the assistant is started by step 12 instead of by the snapshot that follows it. |
| `rpc`, observatory | The number of event lines of that start and the order of operation ids read by the observatory. | Same change. |
| `confirm_and_complete`, observations | Each review carries `seq`. The third `complete_task` call (after "都看过了，完成吧") is refused, so the task stays 进行中: step 08 has no `ended_at` and one less event, step 09 (a field edit) and step 10 (a message) are accepted instead of 409 `task_closed`, and the task list, the revision log (a revision 2 by the user) and the generated document follow from that. In the conversation the step of each refused `complete_task` call reads 完成任务没有做成 instead of 完成任务被拒，完成条件还没满足 (41 differences in the latest run, the `outcome` of the work summaries included). | Reviews and keeps in the task data now carry the number of the event they were recorded at, so the page can tell whether a keep came after the latest review. The task is marked done only after the user clicked "已完成，提交交付物" on the card asking whether the task is finished; typed words do not count, and this scenario never shows such a card. A refused `complete_task` step no longer gives a reason, since the call can be refused either for a missing condition or for missing consent. |
| `confirm_and_complete`, event stream | No `task_changed` to 已完成; the step of the third call reads 完成任务没有做成 instead of 把任务标为已完成, the step of the earlier refused call reads 完成任务没有做成 instead of 完成任务被拒，完成条件还没满足, and the events of steps 09 and 10 follow (83 differences in the latest run, the `outcome` of the work summaries included). | Same as the row above. |
| `confirm_and_complete`, archives | The `complete_task` result is the refusal text instead of 任务 … 已标为已完成, and the session file, raw event stream and backend notes carry steps 09 and 10 (192 differences besides the port). | Same. |
| `confirm_and_complete`, observatory | The task stays 进行中 with two revisions, the run of that call is a refusal recorded in `tool_rejection`, and the counts of runs, turns and requests grow with steps 09 and 10 (42 differences). | Same. |
| `review_gate`, observations | Step 05 is refused with "……已经评过，内容和规则都没变；同一次修订、同一套规则只评审一次。" instead of "……已经评过（第 1 次评审），内容和规则都没变。". Step 06, a forced review of UC-001, is refused (422 `rejected`, same message) instead of starting. So step 07 is no longer refused as "上一批评审还没有做完" and reviews UC-002. In step 14 UC-001 has one review fewer and UC-002 one more, and the reviews carry `seq` (27 differences in the latest run). | An item is reviewed once per revision and rule set; the force flag no longer lets it be reviewed again. |
| `review_gate`, event stream | The review progress, recorded review, batch and finish events of step 07 name UC-002 instead of UC-001; the recorded review has `forced` false and the batch has no `forced` list. | Same change. |
| `review_gate`, archives | The extension's answers to steps 05 to 07, the session file line and the messages about the review name UC-002, and the reviewer's prompt is the one for UC-002. | Same change. |
| `review_gate`, observatory | The same three answers as read by the observatory, and the events written by the reviewing tool call have no `forced`. | Same change. |
| Every scenario but `fake_model`, observations and event stream | Each work summary, as an event and in the conversation read back, has `outcome`: `"replied"` everywhere except the turn stopped in `service`, which has `"stopped_by_user"`. The `outcome` of `work_ended` is unchanged. | A work summary now says how the turn ended, with the same values as `work_ended`, so the page can say so under the summary line, also after a refresh. |
| Every scenario but `fake_model`, observations and event stream | The task status note that opens a session, as an event and in the conversation read back, reads 这条会话开始时（<时分秒>）的任务状况：任务「……」 instead of 【执行者开始这条会话时（<时分秒>）的任务状况：由扩展写入，不是用户打的字】任务「……」 (34 differences in the latest run: one or two in the event stream and one to five in the observations of each scenario; `save_replay` only in the event stream). | The page shows this note with an opening in plain words and without the wording written for the assistant; the assistant still reads the original, so the session files and the fake model's request logs are unchanged. |
| Every scenario but `fake_model` and `save_replay`, observations | Every snapshot has `review_in_progress`, which is `null` in all of them (17 differences in the latest run). | The snapshot now carries the review in progress, so a page reloaded during a review shows it at once. None of these snapshots is read while a review is running. |
| `service`, observations and event stream | The turn stopped before the assistant called a tool or replied now has a work summary (0 steps, `stopped_by_user`): one more `work_summary` event before its `work_ended`, and one more message in the conversation, so the later events and messages move by one (76 and 209 differences in the latest run). | A turn that was stopped or failed counts as a work even without a step or a reply, so the page can say it was stopped; before, a failed turn disappeared after a refresh. |
| `service`, observations, archives and observatory | Step 27, a direct action of the retired kind `confirm`, is refused with the same 400 `bad_request`, but the message listing the operation kinds ends with 、set_review_rules、submit_deliverable 之一。 instead of 、set_review_rules 之一。 The same message appears once in each of the three parts: the observations, the extension's status text in the raw event stream, and the interface request read by the observatory. With the row above, the observations have 77 differences in the latest run. | A direct operation `submit_deliverable` was added, so the message listing the operation kinds names one more. |

What step 12 used to check, a direct action while the assistant is not running, is now covered by the backend tests in
`backend/tests/session_resume.test.ts` (after the assistant exited, before it was started, when resuming finds a different
session, and while it is busy in another session) and `backend/tests/actions.test.ts` (no session given).

What steps 09 and 10 of `confirm_and_complete` used to check, that a field edit and a message after completion are refused with
409 `task_closed`, is now covered by `backend/tests/complete_consent.test.ts`, which completes a task through the card and then
tries both.

Uploads have changed too: an upload whose bytes match a material already in the task is refused with `duplicate_content`,
one whose name is taken by a material with other bytes with `name_taken`, instead of being stored as `<name>-2.<ext>`;
and the unsupported type message is built from the upload extensions; and reviews and keeps carry `seq`, the number of the
event they were recorded at. So `compare.mts --against fixtures` reports the five steps below as different, and only these.
They too go away when the Python version and these saved outputs are retired.

| Step | What differs | Why |
|---|---|---|
| `上传重名文件（加 -2）` | 409 `duplicate_content` ("这份文件与已有的材料《需求说明.md》内容完全相同，没有重复保存。", `data.path` `inputs/需求说明.md`) instead of 200 with `inputs/需求说明-2.md`. | The step uploads the same name with the same bytes, which is now refused as duplicate content; the automatic `-2` name is gone. |
| `上传：类型不支持` | The message is "只接受 .md、.txt 与 Word 的 .docx 文件。" instead of "只接受 .md、.txt 与 .docx（Word）三种文件。". | The message is built from the upload extensions and no longer states a count. |
| `任务页` | The material list has no `inputs/需求说明-2.md`, and it has `inputs/退款规则.docx.locations.json` with `derived_from` `inputs/退款规则.docx`. The two reviews and the keep carry `seq`. | Same as the first row: that file is no longer stored. Uploading a Word file now also writes its location table, a derived file like the projection and the segment list. The page tells whether a keep came after the latest review by `seq`. |
| `条目修订史 UC-001` | The review listed under revision 2 carries `seq`. | Same as the `seq` in `任务页`. |
| `材料原样 .md` | 404 `not_found` ("没有材料 inputs/需求说明-2.md。") instead of 200 with the file. | Same as the first row: the step reads the `-2` file. |

What the first step used to check, a second file under a taken name, is now covered by `backend/tests/upload_dedup.test.ts`
(same name with the same or other bytes, names that differ only in case, encoding or white space, and concurrent uploads).
