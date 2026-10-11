// Runs scripts/preview.mjs /checks?fw=v2|v3|legacy|can in Chromium and prints failures. Usage: node test/e2e/checks.mjs [http://localhost:8798/]
import { launchBrowser } from "./browser.mjs";
const base = (process.argv[2] || "http://localhost:8798/").replace(/\/$/, "");
const b = await launchBrowser(); let bad = 0;
for (const fw of ["v2", "v3", "legacy", "can"]) {
  const p = await b.newPage(); await p.setViewport({ width: 1440, height: 1000 });
  p.on("dialog", (d) => d.accept());
  await p.goto(`${base}/checks?fw=${fw}`, { waitUntil: "load" });
  await p.waitForFunction(() => /^(PASS|FAIL) DR4310/.test(document.title), { timeout: 90000 }).catch(() => {});
  const r = await p.evaluate(() => document.getElementById("check-results")?.textContent ?? "NO RESULT " + document.title);
  console.log(r.split("\n").filter((l) => !l.startsWith("PASS")).join("\n"));
  if (!/^\S+: (\d+)\/\1 PASS/.test(r)) bad++;
  await p.close();
}
await b.close(); process.exit(bad ? 1 : 0);
