// npm preinstall guard: refuses `npm install` in a worktree made by scripts/worktree.sh, whose node_modules/
// links to the main checkout's (or in any checkout where node_modules/ is itself a symbolic link).
// Set TASKWRIGHT_ALLOW_INSTALL=1 to install anyway. The main checkout, with a real node_modules/, is not affected.
//
// This guard only catches `npm install`: `npm ci` empties node_modules/ before any lifecycle script runs.
// That is why scripts/worktree.sh links package by package: npm then removes only the worktree's own links.
import { existsSync, lstatSync } from "node:fs";

let linkedRoot = false;
try { linkedRoot = lstatSync("node_modules").isSymbolicLink(); } catch { /* no node_modules yet */ }
const linkedTree = existsSync("node_modules/.taskwright-linked");

if ((linkedRoot || linkedTree) && process.env.TASKWRIGHT_ALLOW_INSTALL !== "1") {
  console.error(
    "Refusing to install: node_modules/ here links to another checkout's node_modules/, " +
    "so installing would change packages that other checkouts use.\n" +
    "Install in the main checkout instead. To install here anyway, set TASKWRIGHT_ALLOW_INSTALL=1.");
  process.exit(1);
}
