// Sets the release number in version.js: the date (US Eastern) and that day's deployment number --
// "2026/10/22-3" for the third push of Oct 22, like PassTech's. Run by the git pre-commit hook
// (tools/install-hooks.mjs installs it, along with rebuilding index.html, whose script tag carries
// the release), so it never falls behind: each push to the deployed branch is a deployment, so the
// number is one more than the commits already pushed today. Several commits before one push keep
// the same number.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../version.js", import.meta.url);
const git = (cmd) => execSync(`git ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
let pushed = 0;
try {
  const branch = git("rev-parse --abbrev-ref HEAD");
  pushed = Number(git(`rev-list --count --since="${day} 00:00" origin/${branch}`)) || 0;
} catch {
  // No remote branch yet: the first deployment.
}
const release = `${day.replace(/-/g, "/")}-${pushed + 1}`;
const text = readFileSync(FILE, "utf8");
const next = text.replace(/BUILD_NUMBER = "[^"]*"/, `BUILD_NUMBER = "${release}"`);
if (next !== text) writeFileSync(FILE, next);
console.log(`release ${release}`);
