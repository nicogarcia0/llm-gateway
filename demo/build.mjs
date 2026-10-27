// Builds the static demo: the real dashboard page + the gateway's own modules compiled for the browser.
//   node demo/build.mjs [outDir]      (default: demo/dist)
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

// The few Node-only lines in those modules, replaced by browser equivalents.
const SHIMS = {
  "src/adapters.ts": [[`import { randomUUID } from "node:crypto";`, `const randomUUID = () => crypto.randomUUID();`]],
  "src/config.ts": [[`import { readFileSync } from "node:fs";`, `const readFileSync = () => { throw new Error("not available in the browser"); };`]],
  "src/configAdmin.ts": [
    [`import { copyFileSync, existsSync, writeFileSync } from "node:fs";`, `const copyFileSync = () => {}, existsSync = () => false, writeFileSync = () => {};`],
    [`import { randomBytes } from "node:crypto";`, `const randomBytes = (n) => { const b = crypto.getRandomValues(new Uint8Array(n)); return { toString: () => btoa(String.fromCharCode(...b)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "") }; };`],
  ],
  "src/admin.ts": [
    [`import { readFileSync } from "node:fs";`, ``],
    [`const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;`, `const version = ${JSON.stringify(version)};`],
  ],
};
const MODULES = ["src/adapters.ts", "src/config.ts", "src/configAdmin.ts", "src/pool.ts", "src/limits.ts", "src/stats.ts", "src/admin.ts", "demo/mock-api.ts"];

function compile(file) {
  let code = readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
  for (const [from, to] of SHIMS[file] ?? []) {
    if (!code.includes(from)) throw new Error(`demo build: ${file} changed, shim no longer matches: ${from.slice(0, 60)}`);
    code = code.replace(from, () => to);
  }
  // .ts imports become .js siblings in the output folder
  return stripTypeScriptTypes(code).replace(/from "(?:\.\.?\/)+(?:src\/|demo\/)?(\w[\w-]*)\.ts"/g, 'from "./$1.js"');
}

export function build(outDir = join(root, "demo", "dist")) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const f of MODULES) writeFileSync(join(outDir, f.split("/").pop().replace(/\.ts$/, ".js")), compile(f));
  for (const f of ["main.js", "ui.js"]) copyFileSync(join(root, "demo", f), join(outDir, f));

  let html = readFileSync(join(root, "src", "admin.html"), "utf8").replace(/\r\n/g, "\n");
  const swap = (a, b) => { if (!html.includes(a)) throw new Error("demo build: admin.html changed, anchor missing: " + a); html = html.replace(a, () => b); };
  swap("<title>llm-gateway · Admin</title>", "<title>llm-gateway · Live demo</title>");
  swap("</head>", readFileSync(join(root, "demo", "head.html"), "utf8").replace(/\r\n/g, "\n") + "</head>");
  swap("</body>", `<script type="module" src="main.js"></script>\n<script type="module" src="ui.js"></script>\n</body>`);
  writeFileSync(join(outDir, "index.html"), html);

  writeFileSync(join(outDir, "_headers"), `/*
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Cache-Control: public, max-age=300
`);
  return outDir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log("demo built in", build(process.argv[2] ? resolve(process.argv[2]) : undefined));
}
