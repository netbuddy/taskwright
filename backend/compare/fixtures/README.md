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

The TypeScript task service has since changed on purpose in two ways the Python one has not. The saved outputs are not
regenerated for these changes, so `sessions.mts --against fixtures` reports the four parts below as different, and only these.
All four go away when the Python version and these saved outputs are retired.

| Scenario and part | What differs | Why |
|---|---|---|
| `isolation`, event stream | The TypeScript side has one more event at the end of the first task's stream: `service_exiting` with `mode: "server"`. | The service now tells open event streams that it is exiting before it closes them, so pages can say so instead of reconnecting. This scenario stops the service while a stream is open. |
| `rpc`, observations | Step 12, a direct action sent after a restart before the session is opened (an empty `mark_viewed`), is answered 400 `bad_request` ("targets 应当是一个不为空的列表。") instead of 503 `executor_unavailable`. | A direct action now starts the assistant on demand and resumes the page's session, as a message does, and only then is the action itself checked. |
| `rpc`, archives | The raw event stream, the backend notes and the session file have the assistant start one step earlier (122 differences in the latest run). | Same change: the assistant is started by step 12 instead of by the snapshot that follows it. |
| `rpc`, observatory | The number of event lines of that start and the order of operation ids read by the observatory. | Same change. |

What step 12 used to check, a direct action while the assistant is not running, is now covered by the backend tests in
`backend/tests/session_resume.test.ts` (after the assistant exited, before it was started, when resuming finds a different
session, and while it is busy in another session) and `backend/tests/actions.test.ts` (no session given).

Uploads have changed too: an upload whose bytes match a material already in the task is refused with `duplicate_content`,
one whose name is taken by a material with other bytes with `name_taken`, instead of being stored as `<name>-2.<ext>`;
and the unsupported type message is built from the upload extensions. So `compare.mts --against fixtures` reports the four
steps below as different, and only these. They too go away when the Python version and these saved outputs are retired.

| Step | What differs | Why |
|---|---|---|
| `上传重名文件（加 -2）` | 409 `duplicate_content` ("这份文件与已有的材料《需求说明.md》内容完全相同，没有重复保存。", `data.path` `inputs/需求说明.md`) instead of 200 with `inputs/需求说明-2.md`. | The step uploads the same name with the same bytes, which is now refused as duplicate content; the automatic `-2` name is gone. |
| `上传：类型不支持` | The message is "只接受 .md、.txt 与 Word 的 .docx 文件。" instead of "只接受 .md、.txt 与 .docx（Word）三种文件。". | The message is built from the upload extensions and no longer states a count. |
| `任务页` | The material list has no `inputs/需求说明-2.md`. | Same as the first row: that file is no longer stored. |
| `材料原样 .md` | 404 `not_found` ("没有材料 inputs/需求说明-2.md。") instead of 200 with the file. | Same as the first row: the step reads the `-2` file. |

What the first step used to check, a second file under a taken name, is now covered by `backend/tests/upload_dedup.test.ts`
(same name with the same or other bytes, names that differ only in case, encoding or white space, and concurrent uploads).
