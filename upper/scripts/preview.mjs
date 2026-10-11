// Local-only preview and dependency-free browser integration checks. No hardware is requested on /checks.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { page } from "../dist/page.mjs";

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Cache-Control", "no-store");
  const files = { "/app.js": "dist/client.js", "/fake-devices.mjs": "test/e2e/fake-devices.mjs", "/browser-checks.mjs": "test/e2e/browser-checks.mjs" };
  if (files[url.pathname]) { res.setHeader("Content-Type", "text/javascript; charset=utf-8"); res.end(readFileSync(files[url.pathname])); return; }
  if (url.pathname !== "/" && url.pathname !== "/checks") { res.writeHead(404); res.end(); return; }
  let html = page();
  if (url.pathname === "/checks") {
    const mode = ["v2", "v3", "legacy", "can"].includes(url.searchParams.get("fw")) ? url.searchParams.get("fw") : "v3";
    html = html.replace('<script src="/app.js" defer></script>', `<script type="module">
      import { installFakeSerial, installFakePcan } from "/fake-devices.mjs";
      window.__errors = []; addEventListener("error", e => window.__errors.push(e.message)); addEventListener("unhandledrejection", e => window.__errors.push(String(e.reason)));
      window.__confirmations = []; window.confirm = text => { window.__confirmations.push(text); return window.__confirmAccept !== false; };
      localStorage.removeItem("dr4310.autoReconnect"); localStorage.removeItem("dr4310.host"); localStorage.removeItem("dr4310.motorId");
      window.__testMode = ${JSON.stringify(mode)};
      installFakeSerial(${JSON.stringify(mode === "can" ? "v3" : mode)});
      installFakePcan({ nodes: [{id:1,mode:0,faults:0,primary:12.4},{id:3,mode:0,faults:0,primary:12.4}], respondToTx: true });
      await import("/app.js"); await import("/browser-checks.mjs");
    </script>`);
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html);
});
server.listen(Number(process.env.PORT || 8799), "127.0.0.1", () => console.log("Local preview: http://localhost:8799/ · checks: /checks?fw=v3"));
