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
