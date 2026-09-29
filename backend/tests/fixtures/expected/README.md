# Expected outputs for backend tests

Several backend tests compare what the task service produces with the files in this directory, character for character.
The files were first written from the output of the earlier Python task service, which has since been removed from the
repository. They are now maintained by hand: when a change of behavior is intended, change these files in the same commit
as the code, and say in the commit what changed and why.

| File | What it holds | Test that reads it |
|---|---|---|
| `actions.json` | The commands the task service sends to pi for the direct-action bodies and card clicks in `inputs.ts` | `actions.test.ts` |
| `card_annotations.json` | The card annotations computed for the card clicks in `inputs.ts` | `actions.test.ts` |
| `conversation.json` | The conversation with work summaries, and the units of work, for the session entries in `inputs.ts` | `conversation.test.ts` |
| `launch_argv.json` | The pi command line built from the `dev` profile (repository extensions only) | `pi_session.test.ts` |
| `fake_model_cli.json` | The fake model endpoint started from the command line: answers, request log and pi configuration directory for one script and seven requests | `fake_model.test.ts` |
| `observatory_view.json` | What the observatory reads from the archives of one conversation (real pi, fake model) | `observatory_parity.test.ts` |

`inputs.ts` holds the inputs; `observatory.ts` holds the conversation and the observatory call.
The `source` entry of each file records how it was first generated; the command it names no longer exists.
Parts that change from run to run or from machine to machine are replaced by placeholders (repository root, temporary
directories, the location of `pi`, operation ids, times, ports); the tests replace the same parts in their own output.

`observatory_view.json` matters beyond the backend: the observatory reads the archives in exactly this form
(see `observatory/archive-format.md`), so a change here must be matched in the observatory.

## Fields not in the expected outputs

`conversation.test.ts` removes the fields below from its output before comparing it with `conversation.json`, names each of
them, and checks their values in separate assertions; everything else is compared character for character.

| File | Field | Why |
|---|---|---|
| `conversation.json` | `outcome` on every work summary in the conversation and on every unit of work | Each unit of work states how it ended (`replied`, `no_reply`, `stopped_by_user` or `failed`), so the page can say when the user stopped it or it failed, also after a refresh. The field was added after the file was first written. |
