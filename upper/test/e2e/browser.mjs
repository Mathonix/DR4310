import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function launchBrowser(options = {}) {
  const candidates = [process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  const executablePath = candidates.find(p => p && existsSync(p));
  if (!executablePath) throw new Error("找不到 Chromium 浏览器；请设置 CHROME_PATH。puppeteer-core 需由测试环境提供。");
  return puppeteer.launch({ executablePath, headless: true, args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), ...(options.args ?? [])] });
}
export const tempProfile = join(tmpdir(), "dr4310-test-profile.json");
