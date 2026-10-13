import { chromium } from "playwright";
import path from "node:path";
import { pathToFileURL } from "node:url";

const input = path.resolve("dist/pages/index.html");
const output = path.resolve("dist/audio-panel.png");
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", e => console.error("browser page error:", e.message));
  await page.goto(pathToFileURL(input).href);
  await page.locator('button[data-view="debug"]').click();
  await page.locator('button[data-tab="audio"]').click();
  await page.locator("#audioPlay").waitFor({ state: "visible" });
  await page.screenshot({ path: output, fullPage: true });
  console.log("Captured real-built AUDIO UI:", output);
} finally {
  await browser.close();
}
