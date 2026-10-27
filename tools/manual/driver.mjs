// Drives the Scrutineering site in headless Chrome over the DevTools protocol
// and takes screenshots, with demo-server.js standing in for the server:
//   node driver.mjs <steps.mjs> [width] [height]
// (The same driver as the rollcage app's manual, core/app/tools/manual.)
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const stepsFile = resolve(process.argv[2]);
const width = +(process.argv[3] || 1280), height = +(process.argv[4] || 900);
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const port = 9335;
const chrome = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new", "--remote-debugging-port=" + port, "--user-data-dir=" + join(here, "profile"),
  "--window-size=" + width + "," + height, "--hide-scrollbars", "--no-first-run", "--force-color-profile=srgb", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch("http://127.0.0.1:" + port + "/json")).json(); if (targets.find((t) => t.type === "page")) break; } catch (e) {}
  await sleep(200);
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let nextId = 1;
const pending = new Map();
const logs = [];
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") logs.push("exception: " + JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
  if (msg.method === "Runtime.consoleAPICalled" && /error|warn/.test(msg.params.type)) logs.push(msg.params.type + ": " + msg.params.args.map((a) => a.value || a.description).join(" ").slice(0, 300));
});
const send = (method, params = {}) => new Promise((r) => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(join(here, "demo-server.js"), "utf8") });
await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

const api = {
  sleep,
  async go(url) { await send("Page.navigate", { url }); await sleep(3000); },
  // Evaluates an expression (awaits promises) in the page; returns its value.
  async eval(expr) {
    const r = await send("Runtime.evaluate", { expression: "(async () => { " + expr + " })()", awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result && r.result.result && r.result.result.value;
  },
  // Screenshot of the viewport, or of a CSS selector's box (clip), saved as out/<name>.png.
  async shot(name, selector, pad = 8, maxH = 100000) {
    let clip;
    if (selector) {
      const box = await api.eval("const r = document.querySelector(" + JSON.stringify(selector) + ").getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };");
      clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.w + 2 * pad, height: Math.min(maxH, box.h + 2 * pad), scale: 1 };
    }
    const r = await send("Page.captureScreenshot", Object.assign({ format: "png" }, clip ? { clip, captureBeyondViewport: true } : {}));
    writeFileSync(join(out, name + ".png"), Buffer.from(r.result.data, "base64"));
    console.log("shot", name, clip ? Math.round(clip.width) + "x" + Math.round(clip.height) : width + "x" + height);
  },
  log: console.log,
};
try {
  const steps = await import(pathToFileURL(stepsFile).href + "?t=" + Date.now());
  await steps.default(api);
} catch (e) { console.error("FAILED:", e.message); }
if (logs.length) console.log("page errors/warnings:\n" + [...new Set(logs)].join("\n"));
ws.close();
chrome.kill();
