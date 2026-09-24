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

## Parallel work

When several people or agent sessions work on the repository at the same time, give each of them a git worktree and a branch of its own, next to the main checkout:

```bash
scripts/worktree.sh new <name> [<branch>]   # ../taskwright-worktrees/<name> on branch wt/<name> (or <branch>)
scripts/worktree.sh remove <name> [--force] # removes the worktree; the branch is kept
scripts/worktree.sh relink <name>           # rebuilds node_modules/ links, e.g. after an accidental npm install
```

`new` needs at least one commit and a `node_modules/` installed with `npm ci` in the main checkout. It creates the worktree from the current commit and prepares it without downloading anything:

- **No `docs/`.** A sparse checkout, set for that worktree only, leaves out the top-level `docs/` (the task types' own `docs/` directories are still there). The documentation is maintained in the main checkout. When a change needs a documentation update, write what should change in the commit message or the pull request description, and the maintainer applies it. Git refuses to add files under `docs/` in the worktree.
- **`node_modules/` is shared.** It is a real directory that holds one link per package to the main checkout's `node_modules/`. Do not run `npm install` or `npm ci` in a worktree: the preinstall guard refuses `npm install`, but only after npm has already removed most of the links, and `npm ci` cannot be refused at all (it replaces the links with a full install of its own). The main checkout is not harmed in either case; run `scripts/worktree.sh relink <name>` to go back to the shared packages. To change dependencies, change them in the main checkout.
- **Python is not shared.** Each worktree has its own `.venv/` with the packages installed in editable mode from the worktree itself (with uv when it is available), so the code runs from the worktree. Activate it in every new terminal: `. .venv/bin/activate`.

Run the services with ports that no other worktree uses, for example:

```bash
TASKWRIGHT_API_PORT=8801 TASKWRIGHT_WEB_PORT=5701 scripts/dev.sh
```

Tasks and archives go to the worktree's own `tasks/` and `runs/`. `remove` refuses while the worktree has uncommitted changes, and while `tasks/` or `runs/` has anything in it, which it lists; copy out what you want to keep, then run `remove <name> --force` to delete them together with the worktree.

To merge a branch back: rebase it on `main` (or merge `main` into it), run `scripts/test-all.sh` and `scripts/check-public.sh` in the worktree, and open a pull request or merge it from the main checkout. Before merging, the maintainer checks that the branch does not touch the documentation:

```bash
git diff --stat main...<branch> -- docs/    # must print nothing
```

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
- `docs/capabilities.md` (and its Chinese translation) is derived from the startup profile's tool allowlist, the tools and commands under `agent/src/`, and the task definitions and skills under `task-types/`. When you change any of these, update it in the same commit (from a worktree, describe the update in the commit message instead; see Parallel work).

## Pull requests

Keep each pull request to one change. Describe what changed and how you tested it. Interface changes must update `docs/api.md` in the same pull request; from a worktree, describe the update in the pull request description and the maintainer applies it.
