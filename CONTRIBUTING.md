# Contributing to Taskwright

Thank you for helping. This page covers how to set up, test, and submit changes.

## Set up

```bash
npm install -g @earendil-works/pi-coding-agent@0.85.1   # the agent runtime; integration tests need it
npm ci
python3 -m venv .venv && . .venv/bin/activate
python3 -m pip install -e 'observatory[test]' -e 'server[test]'
```

## Before every commit

```bash
scripts/check-public.sh    # must print "nothing found"
scripts/test-all.sh        # agent, sim and web tests, the web build, and pytest for server, observatory and sim
```

`check-public.sh` blocks private paths, internal network addresses, credential values, and internal document references from entering the repository. Run it with `--message <file>` to check a commit message too. CI runs both scripts on every push and pull request. Integration tests use a local fake model endpoint, so no model service or network access is needed.

## The three kinds of code, and their boundaries

These boundaries are what keep the deliverable trustworthy. Please keep them:

1. **Only the agent's tools and extension commands write the task database** (`agent/src/lib/`). Every write goes through the same core functions, runs in one transaction, checks base versions, and records one event. The table definitions exist only in `agent/src/lib/schema.ts`, and only `agent/src/lib/db.ts` writes the event table.
2. **The server and the observatory never write the task database.** They open it read-only (`observatory/taskwright_observatory/taskdb.py` is the one reader) and never interpret or grade the content.
3. **The web interface only reacts to events.** A request's response says only "accepted" or "rejected"; the interface changes when the corresponding event arrives. No optimistic updates.

There are no content rules or keyword lists in the code: whether a use case is well written is a judgement for the reviewer role, not for validation code. Code checks structure only: collections, fields, types, required fields, and sources.

`agent/README.md` lists grep commands that verify boundary 1.

## Style

- Python: standard library only in `server/` and `observatory/`; four-space indentation.
- TypeScript: ES modules, run directly by Node (no build step for `agent/` and `sim/`); two-space indentation.
- Texts shown to users, collection names and field names come from the task definition, never hard-coded in the web interface.
- Tests travel with the code: change a behaviour, change or add its test in the same commit.
- `docs/capabilities.md` (and its Chinese translation) is derived from the startup profile's tool allowlist, the tools and commands under `agent/src/`, and the task definitions and skills under `task-types/`. When you change any of these, update it in the same commit.

## Pull requests

Keep each pull request to one change. Describe what changed and how you tested it. Interface changes must update `docs/api.md` in the same pull request.
