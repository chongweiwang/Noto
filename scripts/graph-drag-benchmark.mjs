import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// This measures graph Canvas paint intervals in a browser, not physical display FPS.
// All generated notes and server data are isolated under .local.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, ".local", `graph-drag-benchmark-${Date.now()}`);
const vault = join(output, "vault");
const data = join(output, "data");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NOTO_PLAYWRIGHT_MODULE || "playwright");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (i) => `Note${String(i).padStart(4, "0")}`;
const directory = (i) => `Group${String(Math.floor(i / 50)).padStart(2, "0")}`;
const link = (i) => `[[${directory(i)}/${note(i)}]]`;

async function createFixture() {
  await mkdir(data, { recursive: true });
  await Promise.all(Array.from({ length: 20 }, (_, i) => mkdir(join(vault, directory(i * 50)), { recursive: true })));
  await Promise.all(Array.from({ length: 1000 }, (_, i) =>
    writeFile(join(vault, directory(i), `${note(i)}.md`), `# ${note(i)}\n\n${link((i + 1) % 1000)} ${link((i + 50) % 1000)} ${link((i + 200) % 1000)}\n`),
  ));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function main() {
  await createFixture();
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, password = randomBytes(24).toString("base64url");
  const log = createWriteStream(join(output, "server.log"));
  const executable = process.env.NOTO_BENCH_SERVER || join(root, "target", "debug", process.platform === "win32" ? "noto-server.exe" : "noto-server");
  const server = spawn(executable, [], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NOTO_VAULT_DIR: vault, NOTO_DATA_DIR: data, NOTO_STATIC_DIR: join(root, "desktop", "out"), NOTO_LISTEN: `127.0.0.1:${port}`, NOTO_PUBLIC_ORIGIN: origin, NOTO_PASSWORD: password },
  });
  server.stdout.pipe(log); server.stderr.pipe(log);
  let serverError;
  server.once("error", (error) => { serverError = error; });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if (serverError) throw serverError;
      try { ready = (await fetch(`${origin}/health`)).ok; } catch { /* starting */ }
      if (ready) break;
      await wait(100);
    }
    if (!ready) throw new Error(`Server did not start; see ${join(output, "server.log")}`);
    browser = await chromium.launch({ executablePath: process.env.NOTO_CHROME_EXECUTABLE || undefined, headless: true, args: ["--disable-background-networking", "--disable-extensions"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const clear = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        if (this.canvas.getAttribute("aria-label") === "知识图谱画布" && window.__recordGraphFrames) window.__graphFrames.push(performance.now());
        return clear.apply(this, args);
      };
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator("#web-password").fill(password);
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByRole("button", { name: "Note0000.md", exact: true }).first().click({ timeout: 30000 });
    await page.getByRole("button", { name: "知识图谱", exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector(".graph-status")?.innerText.includes("展示 1000 / 3000"), null, { timeout: 45000 });
    await page.waitForTimeout(5500);
    await page.getByRole("button", { name: "进入图谱专注模式" }).click();
    await page.waitForTimeout(300);

    // Capture one rendered frame to count overlaps and locate the current note.
    await page.evaluate(() => {
      const p = CanvasRenderingContext2D.prototype;
      const original = { beginPath: p.beginPath, arc: p.arc, fill: p.fill, fillText: p.fillText, clearRect: p.clearRect };
      let arc = null;
      const graph = (ctx) => ctx.canvas.getAttribute("aria-label") === "知识图谱画布";
      window.__restoreGraphSample = () => Object.assign(p, original);
      p.clearRect = function (...args) { if (graph(this)) window.__graphSample = { nodes: [], labels: [] }; return original.clearRect.apply(this, args); };
      p.beginPath = function (...args) { arc = null; return original.beginPath.apply(this, args); };
      p.arc = function (x, y, radius, ...args) { if (graph(this)) arc = { x, y, radius }; return original.arc.call(this, x, y, radius, ...args); };
      p.fill = function (...args) { if (graph(this) && arc) window.__graphSample.nodes.push({ ...arc }); arc = null; return original.fill.apply(this, args); };
      p.fillText = function (value, x, y, ...args) { if (graph(this)) window.__graphSample.labels.push({ value, x, y }); return original.fillText.call(this, value, x, y, ...args); };
    });
    await page.getByRole("button", { name: "适应视图" }).click();
    await page.waitForTimeout(250);
    const sample = await page.evaluate(() => { const result = window.__graphSample; window.__restoreGraphSample(); return result; });
    let overlapPairs = 0;
    const overlapping = new Set();
    for (let i = 0; i < sample.nodes.length; i++) for (let j = i + 1; j < sample.nodes.length; j++) {
      const a = sample.nodes[i], b = sample.nodes[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius - .1) { overlapPairs++; overlapping.add(i); overlapping.add(j); }
    }
    const label = sample.labels.find((item) => item.value === "Note0000");
    const node = label && sample.nodes.find((item) => Math.abs(item.x - label.x) < .1 && Math.abs(item.y + item.radius + 5 - label.y) < .1);
    if (!node) throw new Error("Could not find the current note in the rendered graph");
    const box = await page.locator('canvas[aria-label="知识图谱画布"]').boundingBox();
    await page.screenshot({ path: join(output, "before-drag.png") });
    await page.mouse.move(box.x + node.x, box.y + node.y);
    await page.mouse.down();
    await page.evaluate(() => { window.__graphFrames = []; window.__recordGraphFrames = true; });
    for (let i = 1; i <= 100; i++) {
      await page.mouse.move(box.x + node.x + 160 * i / 100, box.y + node.y + 45 * Math.sin(i / 100 * Math.PI));
      await page.waitForTimeout(16);
    }
    const frames = await page.evaluate(() => { window.__recordGraphFrames = false; return window.__graphFrames; });
    await page.mouse.up();
    const intervals = frames.slice(1).map((time, i) => time - frames[i]);
    const sorted = [...intervals].sort((a, b) => a - b);
    console.log(JSON.stringify({
      output, status: await page.locator(".graph-status").innerText(), nodes: sample.nodes.length, overlapPairs, overlappingNodes: overlapping.size,
      graphPaints: frames.length, sampleDurationMs: frames.at(-1) - frames[0], canvasPaintsPerSecond: intervals.length ? 1000 * intervals.length / (frames.at(-1) - frames[0]) : 0,
      p95IntervalMs: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? null, worstIntervalMs: sorted.at(-1) ?? null,
      intervalsOver33Ms: intervals.filter((value) => value > 33.4).length, errors,
    }, null, 2));
  } finally {
    if (browser) await browser.close();
    server.kill();
    log.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
