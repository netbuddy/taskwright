# Taskwright

Taskwright is a general task-oriented agent. You give it a **task definition**; it talks with a person, produces the deliverable the definition describes, and keeps every piece of that deliverable **traceable to a source**, **confirmed by the person**, and **recorded in a history that cannot be rewritten**. It is built on [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Writing a software requirements specification is the first task type it ships with.

[中文说明](README.zh-CN.md)

**License.** The core is licensed under the [GNU AGPL-3.0](LICENSE). A commercial license is available separately; see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

> Status: 0.1.0-alpha. The interfaces may still change between releases.

## What it does

- It works from a task definition: which item collections make up the deliverable, which fields each item has, what counts as complete, and where the method and the domain rules are written. A different task definition is a different kind of task.
- It produces items in conversation, and every version of every item carries its sources: a verbatim excerpt from a material, the user's own words, a marked "added by the agent" note, or the user's own direct edit.
- The user can edit, confirm or undo items directly in the interface; every change is a new version in an append-only history, and each write is recorded with its event in one transaction.
- Completion is checked by code against the task definition's conditions, and the deliverable is rendered into a document from a template; neither step goes through a model.
- Everything can be reviewed afterwards: every run, turn, tool call and rejection is recorded.

The bundled task type, *software requirements specification*, adds four item collections, the rules for use cases and EARS sentences, and the executor's way of working. The full list of what the current version can and cannot do is in [docs/capabilities.md](docs/capabilities.md).

## Components

The **agent** (`agent/`) is built on pi: pi provides the agent loop, model access and session records; Taskwright's tools and extensions are loaded as pi extensions and are the only code that writes the task database. The **server** (`server/`) starts and supervises pi and serves the HTTP/SSE API. The **web** interface (`web/`) and the read-only **observatory** (`observatory/`) show what happened. The **simulator** (`sim/`) drives the agent as a simulated user, and `task-types/` holds the starting files of each task type. Details are in [docs/architecture.md](docs/architecture.md).

## Install in short

```bash
npm install -g @earendil-works/pi-coding-agent@0.85.1   # then connect a model in pi
git clone https://github.com/netbuddy/taskwright.git && cd taskwright
python3 -m venv .venv && . .venv/bin/activate
make install                                            # npm ci + pip install -e 'observatory[test]' -e 'server[test]'
scripts/dev.sh                                          # then open http://localhost:5680
# in every new terminal, run `. .venv/bin/activate` first
```

Requirements, model setup, ports and troubleshooting are in [docs/deployment.md](docs/deployment.md).

## Repository layout

```
agent/         pi tools, extensions, command-line entry points (src/), prompts, tests
server/        taskwright_server: task service, create-task, terminal client, TUI, fake model endpoint
observatory/   taskwright_observatory: read-only web app and database readers; archive-format.md
web/           browser interface
sim/           simulated user, run driver, judge, example persona
task-types/    srs-authoring: task definition, skill, domain rules, document template
examples/      library-lending: example material and a scripted run
docs/          capabilities, deployment, user guide, API reference, architecture
scripts/       check-public.sh, dev.sh, test-all.sh
```

## Documentation

For people who use Taskwright:

- [Capabilities](docs/capabilities.md): what the current version can do, and what it cannot do yet
- [Deployment](docs/deployment.md): dependencies, connecting a model, starting the services, troubleshooting
- [User guide](docs/user-guide.md): the web workflow, the example, other ways to work, the observatory

For integrators and contributors:

- [API reference](docs/api.md): HTTP endpoints, the event stream, errors
- [Architecture](docs/architecture.md): components, data flow, database tables
- [Archive format](observatory/archive-format.md): the backend's JSONL archives
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, tests, code boundaries

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues. This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
