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
  const darkOutput = path.resolve("dist/audio-panel-dark.png");
  await page.locator("#themeToggle").click();
  await page.waitForTimeout(800); // wait for theme CSS transitions before capture
  console.log("theme:", await page.evaluate(() => ({
    mode: document.documentElement.dataset.theme,
    background: getComputedStyle(document.body).backgroundColor,
  })));
  await page.screenshot({ path: darkOutput, fullPage: true });
  console.log("Captured real-built AUDIO UI:", output, darkOutput);
} finally {
  await browser.close();
}
