// Bundles the diagram check engine (backend/src/diagram_engine.mjs) with mermaid and everything it imports into
// files that Node loads without a node_modules directory. release/build.mjs runs it with the repository's vite:
//   vite build --config release/diagram/vite.config.mjs --outDir <dir> --emptyOutDir
// The entry becomes <dir>/diagram_engine.mjs; the code mermaid loads on demand becomes separate files under
// <dir>/assets/, which release/diagram/prune.mjs then reduces to the ones the five kinds of diagram use.
// <dir>/modules.json lists, for every file written, the source files bundled into it: build.mjs reads it to find
// the npm packages whose code is in the files it keeps, and ships their licence files.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export default defineConfig({
  root: REPO,
  publicDir: false,
  logLevel: "warn",
  build: { ssr: path.join(REPO, "backend", "src", "diagram_engine.mjs"), target: "node24", minify: true },
  ssr: { noExternal: true },
  plugins: [{
    name: "list-bundled-modules",
    generateBundle(_options, bundle) {
      const modules = {};
      for (const [file, chunk] of Object.entries(bundle)) if (chunk.type === "chunk") modules[file] = Object.keys(chunk.modules);
      this.emitFile({ type: "asset", fileName: "modules.json", source: JSON.stringify(modules) });
    },
  }],
});
