// Bundles backend/src/docx_lib.mjs, the few things the backend uses from the docx package, with docx and everything
// it imports into one file that Node loads without a node_modules directory. release/build.mjs runs it with the
// repository's vite:
//   vite build --config release/docx/vite.config.mjs --outDir <dir> --emptyOutDir
// The entry becomes <dir>/docx_lib.mjs. <dir>/modules.json lists the source files bundled into it: build.mjs reads it
// to find the npm packages whose code is in the file, and ships their licence files.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export default defineConfig({
  root: REPO,
  publicDir: false,
  logLevel: "warn",
  build: { ssr: path.join(REPO, "backend", "src", "docx_lib.mjs"), target: "node24", minify: true },
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
