import * as esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./build-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist", "pages");
const renderer = await esbuild.build({
  entryPoints: [path.join(root, "src", "page.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { page } = await import(
  "data:text/javascript;base64," + Buffer.from(renderer.outputFiles[0].contents).toString("base64")
);

await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, "index.html"), page("./app.js"), "utf8");
await fs.copyFile(path.join(root, "dist", "client.js"), path.join(output, "app.js"));
await fs.copyFile(path.join(root, "dist", "serial-worker.js"), path.join(output, "serial-worker.js"));
await fs.writeFile(path.join(output, ".nojekyll"), "");
console.log("GitHub Pages site:", output);
