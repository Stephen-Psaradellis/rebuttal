// Drive Rebuttal scene by scene, timed to the narration clips, and record the browser.
//   node video/record.mjs [video/out/]   (run from products/airwallex-disputes)
// Prep (real, not mocked): runs src/run.js and src/board.js with the caller's LLM_* env, so
// the terminal scene shows that run's actual output and the board carries that run's letters.
// Writes out/screen.webm and out/timeline.json ({scene: start seconds in the video}).
// Adapted from Owed's video/record.mjs (github.com/Stephen-Psaradellis/owed).
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
// Playwright: $PLAYWRIGHT if set, else a normal install found up the folder tree (npm i -D playwright).
const loadPlaywright = () => {
  for (const id of [process.env.PLAYWRIGHT, "playwright"]) {
    if (!id) continue;
    try { return require(id); } catch {}
  }
  throw new Error("Playwright not found: npm i -D playwright && npx playwright install chromium");
};
const { chromium } = loadPlaywright();

const argv = process.argv.slice(2);
const modeAt = argv.indexOf("--mode");
const MODE = modeAt >= 0 ? argv.splice(modeAt, 2)[1] : "demo";
const OUT = resolve(argv[0] || "video/out");
const NOW = process.env.REBUTTAL_NOW || "2026-10-25T00:00:00Z";
const lengths = JSON.parse(readFileSync(join(OUT, "lengths.json"), "utf8"));
const PAD = 0.9;

// --mode sandbox replays a finished sandbox run instead of re-running it (a re-run would seed
// ten new disputes): the board built by `board.js --seed`, that run's saved output, and the seed
// file's report, which maps each fixture case to the real dst_ id the board's cards carry.
let site, runOut, cmd, ids = {};
if (MODE === "sandbox") {
  site = resolve(process.env.REBUTTAL_SITE || "out/sandbox-board");
  runOut = readFileSync(resolve(process.env.REBUTTAL_RUN_LOG || "out/sandbox-run.txt"), "utf8");
  for (const l of JSON.parse(readFileSync(resolve("out/sandbox-seed.json"), "utf8")).report) {
    const m = l.match(/^(pd_\w+): (dst_\w+)/);
    if (m) ids[m[1]] = m[2];
  }
  cmd = "node src/run.js --sandbox --paid --submit";
} else {
  site = join(OUT, "site");
  runOut = execFileSync(process.execPath, ["src/run.js", "--now", NOW], { encoding: "utf8", env: process.env });
  execFileSync(process.execPath, ["src/board.js", "--now", NOW, "--out", site], { encoding: "utf8", env: process.env });
  cmd = `node src/run.js --now ${NOW}`;
}
writeFileSync(join(OUT, "run.txt"), runOut);
const letters = (runOut.match(/^\s+letter\s+.*$/gm) || []).map((l) => l.trim());
console.error(`prep: ${letters.length} letter lines; first: ${letters[0] || "-"}`);

const browser = await chromium.launch({ args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const t0 = Date.now();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: 1440, height: 900 } }, colorScheme: "light",
});
const page = await ctx.newPage();
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
await page.setContent(`<!doctype html><html><body style="margin:0;background:#141413;color:#e8e6dc;font:16px/1.45 Consolas,monospace">
<div style="padding:14px 22px;background:#262624;color:#a3a29b;font:14px system-ui">rebuttal - one pass over the open disputes</div>
<pre id="t" style="margin:0;padding:18px 22px;height:calc(100vh - 47px);overflow:hidden;white-space:pre-wrap">
<span style="color:#7fb0ff">$</span> ${esc(cmd)}
</pre></body></html>`);

const CURSOR_CSS = `#rec-cursor{position:fixed;left:0;top:0;width:22px;height:22px;margin:-4px 0 0 -4px;z-index:2147483647;pointer-events:none;
    transition:transform .6s cubic-bezier(.3,.7,.2,1)}
  #rec-cursor svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
  #rec-ring{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #1f5fbf;
    z-index:2147483646;pointer-events:none;opacity:0}
  #rec-ring.go{animation:ring .5s ease-out}
  @keyframes ring{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(1.4)}}
  #rec-lb{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:2147483640}
  #rec-lb img{max-height:92vh;max-width:70vw;box-shadow:0 8px 40px rgba(0,0,0,.5)}`;
let cur = { x: 720, y: 450 };
async function addCursor() {
  await page.addStyleTag({ content: CURSOR_CSS });
  await page.evaluate(([x, y]) => {
    const c = document.createElement("div"); c.id = "rec-cursor";
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.4L21 11z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    c.style.transform = `translate(${x}px,${y}px)`;
    const r = document.createElement("div"); r.id = "rec-ring";
    document.body.append(c, r);
  }, [cur.x, cur.y]);
}
const sleep = (ms) => page.waitForTimeout(ms);
async function moveTo(target, dx = 0, dy = 0) {
  const loc = typeof target === "string" ? page.locator(target).first() : target;
  const b = await loc.boundingBox();
  if (!b) return null;
  const x = Math.min(b.x + b.width / 2 + dx, 1400), y = Math.min(b.y + b.height / 2 + dy, 880);
  await page.evaluate(([x, y]) => { document.getElementById("rec-cursor").style.transform = `translate(${x}px,${y}px)`; }, [x, y]);
  await page.mouse.move(x, y, { steps: 12 });
  cur = { x, y };
  await sleep(650);
  return { x, y };
}
async function click(target) {
  const p = await moveTo(target);
  if (!p) throw new Error("not found: " + target);
  await page.evaluate(([x, y]) => { const r = document.getElementById("rec-ring"); r.style.left = x + "px"; r.style.top = y + "px";
    r.classList.remove("go"); void r.offsetWidth; r.classList.add("go"); }, [p.x, p.y]);
  await page.mouse.click(p.x, p.y);
  await sleep(300);
}
async function scrollTo(sel, block = "start") {
  await page.evaluate(([s, block]) => document.querySelector(s).scrollIntoView({ behavior: "instant", block }), [sel, block]);
  await sleep(1000);
}
const card = (id) => `article[id="${ids[id] || id}"]`;

const scenes = {
  async intro() { await sleep(1500); },
  async run() {
    // The real output of this run, printed at a readable pace.
    const lines = runOut.split("\n");
    const ms = Math.max(40, Math.floor(((lengths.run || 15) - 2) * 1000 / lines.length));
    await page.evaluate(async ([lines, ms]) => {
      const t = document.getElementById("t");
      for (const l of lines) {
        const s = document.createElement("span");
        s.textContent = l + "\n";
        if (/^(pd|dst)_/.test(l)) s.style.color = "#f2c46d";
        else if (/^\s+decide/.test(l)) s.style.color = "#9fd49a";
        else if (/^\s+letter/.test(l)) s.style.color = "#c8a7ff";
        t.append(s); t.scrollTop = t.scrollHeight;
        await new Promise((r) => setTimeout(r, ms));
      }
    }, [lines, ms]);
  },
  async board() {
    await page.goto(pathToFileURL(join(site, "index.html")).href);
    await addCursor();
    await sleep(500);
    for (const tile of await page.locator(".tile").all()) await moveTo(tile);
  },
  async escalate() {
    await scrollTo(card("pd_demo_03"));
    await moveTo(`${card("pd_demo_03")} .why`);
    await moveTo(`${card("pd_demo_03")} .miss`).catch(() => {});
  },
  async challenge() {
    await scrollTo(card("pd_demo_02"));
    await moveTo(`${card("pd_demo_02")} .why`);
    const fields = page.locator(`${card("pd_demo_02")} .fields li`);
    for (let i = 0; i < Math.min(await fields.count(), 4); i++) await moveTo(fields.nth(i), -200);
    const link = page.locator(`${card("pd_demo_02")} .fields a`).first();
    const href = await link.getAttribute("href");
    await click(link.locator("xpath=.").first()).catch(() => {});
    // target=_blank opens a tab the recording cannot see; show the same image in place instead.
    for (const p of ctx.pages()) if (p !== page) await p.close();
    await page.evaluate((h) => { const d = document.createElement("div"); d.id = "rec-lb"; d.innerHTML = `<img src="${h}">`; document.body.append(d); }, href);
    await sleep(3500);
    await page.evaluate(() => document.getElementById("rec-lb")?.remove());
  },
  async letter() {
    const sum = page.locator(`${card("pd_demo_02")} details.letter summary`);
    await click(sum);
    await sleep(600);
    await page.locator(`${card("pd_demo_02")} details.letter pre`).evaluate((e) => e.scrollIntoView({ behavior: "instant", block: "center" }));
    await sleep(1200);
    await moveTo(`${card("pd_demo_02")} details.letter pre`, 0, -60);
    await moveTo(`${card("pd_demo_02")} details.letter .meta`).catch(() => {});
  },
  async accept() {
    await scrollTo(card("pd_demo_05"));
    await moveTo(`${card("pd_demo_05")} .why`);
    await sleep(2500);
    await scrollTo(card("pd_demo_08"));
    await moveTo(`${card("pd_demo_08")} .why`);
    await moveTo(`${card("pd_demo_08")} .miss`).catch(() => {});
  },
  async trail() {
    await scrollTo(card("pd_demo_02"));
    const det = page.locator(`${card("pd_demo_02")} details`).filter({ hasText: "Audit trail" }).first();
    await click(det.locator("summary"));
    await sleep(900);
    await det.evaluate((e) => e.scrollIntoView({ behavior: "instant", block: "start" }));
    await sleep(1500);
    const body = page.locator(`${card("pd_demo_02")} details`).filter({ hasText: "Request body" }).first();
    await click(body.locator("summary"));
    await sleep(600);
    await body.evaluate((e) => e.scrollIntoView({ behavior: "instant", block: "start" }));
    await sleep(1200);
    await moveTo(body.locator("pre"), 0, -120);
  },
  async outro() {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await sleep(1000);
    await moveTo(".note");
  },
};

const timeline = {};
const order = JSON.parse(readFileSync(new URL("./scenes.json", import.meta.url), "utf8")).scenes.map((s) => s.id);
for (const id of order) {
  const start = Date.now();
  timeline[id] = (start - t0) / 1000;
  try { await scenes[id](); } catch (e) { console.error(`scene ${id}: ${e.message}`); }
  const spent = (Date.now() - start) / 1000;
  const want = (lengths[id] || 5) + PAD;
  if (spent < want) await sleep((want - spent) * 1000);
  else timeline[id + "_overrun_s"] = +(spent - want).toFixed(2);
}
timeline._end = (Date.now() - t0) / 1000;
const video = page.video();
await ctx.close();
const src = await video.path();
const dst = join(OUT, "screen.webm");
renameSync(src, dst);
await browser.close();
writeFileSync(join(OUT, "timeline.json"), JSON.stringify(timeline, null, 1));
console.log(JSON.stringify({ video: dst, letters: letters.length, ...timeline }));
