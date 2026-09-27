# Outputs of the Python version, kept for comparison

The task service used to exist in Python as well (`server/taskwright_server/`). While both versions existed, several backend tests
ran the Python version in a child process and compared its output with the TypeScript version's, character for character.
The Python version is being removed, so its output on the same inputs is kept here and the tests compare against these files.

These files are temporary. They will be deleted once the comparisons are rewritten as integration tests that assert facts
(what was written to the database, which events arrived) instead of matching an older implementation's output.

| File | Python code that produced it | Test that reads it |
|---|---|---|
| `actions.json` | `service/executor.py`: `action` and `card_click` on the direct-action bodies and card clicks in `inputs.ts` | `actions.test.ts` |
| `card_annotations.json` | `service/app.py`: `card_annotation` | `actions.test.ts` |
| `conversation.json` | `service/conversation.py` and `service/work_summary.py`: the conversation with work summaries, and the units of work | `conversation.test.ts` |
| `launch_argv.json` | `launch.py`: `build_command` for the `dev` profile (repository extensions only) | `pi_session.test.ts` |
| `fake_model_cli.json` | `python -m taskwright_server.fake_model`: answers, request log and pi configuration directory for one script and seven requests | `fake_model.test.ts` |
| `observatory_view.json` | the Python task service running one conversation (real pi, TypeScript fake model), read by the observatory | `observatory_parity.test.ts` |

`inputs.ts` holds the inputs both sides use; `observatory.ts` holds the conversation and the observatory call.
Every file has a `source` entry with the commit of the last change to `server/` when it was generated, the date and the command.
Parts that change from run to run or from machine to machine are replaced by placeholders before saving (repository root,
temporary directories, the location of `pi`, operation ids, times, ports); the tests replace the same parts in their own output.

To regenerate (only possible while `server/` is still in the repository; needs `pi` on `PATH`):

```
TASKWRIGHT_PYTHON=.venv/bin/python node backend/tests/fixtures/py/generate.mts
```
