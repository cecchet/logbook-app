// Installs the git pre-commit hook that sets the release number (tools/bump-version.mjs) in every
// commit, and rebuilds index.html with it. Run once per clone: node tools/install-hooks.mjs
import { writeFileSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";

const hooks = execSync("git rev-parse --git-path hooks", { encoding: "utf8" }).trim();
const hook = `${hooks}/pre-commit`;
writeFileSync(hook, "#!/bin/sh\nnode tools/bump-version.mjs && node tools/build-index.js && git add version.js index.html\n");
try {
  chmodSync(hook, 0o755);
} catch {
  // Windows: git runs it anyway.
}
console.log(`installed ${hook}`);
