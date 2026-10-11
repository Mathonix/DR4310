/**
 * dr4310.233688.xyz — DR4310 FOC 电机上位机
 * Static app served by a Worker; all device I/O (WebUSB PCAN, Web Serial) runs in the browser.
 */
import { CLIENT_JS } from "./client-bundle";
import { page } from "./page";

export interface Env {}

const SEC_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "usb=(self), serial=(self)",
};

function resp(body: string | null, type: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": type, "Cache-Control": "no-cache", ...SEC_HEADERS },
  });
}

let HTML: string | null = null;

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const head = request.method === "HEAD";
    if (url.pathname === "/app.js") return resp(head ? null : CLIENT_JS, "application/javascript; charset=utf-8");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      HTML ??= page();
      return resp(head ? null : HTML, "text/html; charset=utf-8");
    }
    if (url.pathname === "/health") return new Response(head ? null : "ok");
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response("Not Found", { status: 404 });
  },
};
