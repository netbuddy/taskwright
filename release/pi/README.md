# The pi that goes into the desktop packages

This directory pins the pi coding agent that `release/build.mjs` puts into the desktop packages. Nothing is installed here: the build copies the three files below into its staging directory, outside the repository, and runs `npm ci` there.

| File | What it is for |
|---|---|
| `package.json` | One dependency, `@earendil-works/pi-coding-agent`, at an exact version. The build reads the pinned version from here. |
| `package-lock.json` | Every package pi depends on, with its version and checksum. pi's own package no longer ships a lock file, so without this one two builds could pack different dependencies. |
| `.npmrc` | `install-strategy=shallow` makes npm put pi's dependencies inside pi's own `node_modules/`, the layout a global install has and the one the build copies from. `registry` keeps the lock file's addresses on the public npm registry whatever the machine's own npm configuration says. |

Do not run `npm install` or `npm ci` in this directory.

## Upgrading pi

1. Change the version in `package.json` (an exact version, no `^` or `~`).
2. In this directory, regenerate the lock file without installing anything:

   ```bash
   npm install --package-lock-only --ignore-scripts
   ```

   It must not create a `node_modules/` here. Review the lock file's diff: it is the list of what changes inside the packages.
3. Run the lock file test, from `backend/`: `node --test --import ./tests/deadline.ts tests/release_pi_lock.test.ts`.
4. Build the packages once (see `release/README.md`) and start them, including opening a session so the packed pi runs. The build keeps only the part of pi that it loads at run time (`PI_KEEP` in `release/build.mjs`); a new pi version may load something else.
5. Update the pi version written in the documentation (`README.md`, `CONTRIBUTING.md`, `docs/deployment.md` and their translations).
