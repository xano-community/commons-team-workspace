// One way to start the browser for every check, so a speed budget measures the app and not the laptop it runs on.
//
// A fresh Chrome profile turns on Energy Saver at 20% battery and caps every page at 30 frames a second. Each measure here
// waits for a frame, so that cap adds about 17 ms per frame to all of them, on any build, a blank page included. The budgets
// are for a mid-range laptop at 4x CPU throttle, so the cap stays off, and a check that still can't get 60 frames a second
// stops instead of scoring what it can't measure.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SLOWEST_FRAME_MS = 20;
const CANT_MEASURE = 2;

/** The median gap between frames on an empty page. */
async function frameInterval(browser) {
  const page = await browser.newPage();
  await page.goto("data:text/html,<title>frames</title>");
  await page.bringToFront();
  const gaps = await page.evaluate(() => new Promise((done) => {
    const seen = [];
    let last = performance.now();
    const frame = (now) => { seen.push(now - last); last = now; if (seen.length < 40) requestAnimationFrame(frame); else done(seen.slice(5)); };
    requestAnimationFrame(frame);
  }));
  await page.close();
  return [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
}

export async function launchBrowser() {
  const profile = mkdtempSync(join(tmpdir(), "qa-chrome-"));
  mkdirSync(join(profile, "Default"));
  writeFileSync(join(profile, "Local State"), JSON.stringify({ performance_tuning: { battery_saver_mode: { state: 0 } } }));
  const browser = await puppeteer.launch({ executablePath, headless: true, userDataDir: profile, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  browser.once("disconnected", () => { try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Chrome still flushing: the temp folder clears itself */ } });
  const interval = await frameInterval(browser);
  if (interval > SLOWEST_FRAME_MS) {
    await browser.close();
    console.error(`✗ can't measure here: frames arrive every ${interval.toFixed(1)} ms, and the speed budgets assume 16.7 ms`);
    process.exit(CANT_MEASURE);
  }
  return browser;
}
