import { access } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Browser } from "playwright-core";

export type RenderResult = { html: string; status: "complete" | "partial"; requests: number;
  errors: Array<{ url: string; error: string }> };
export type RenderResource = { url: string; body: string; status: number; contentType: string; headers: Record<string, string> };

export async function browserExecutable(): Promise<string | null> {
  const paths = process.platform === "win32" ? [
    join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ] : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  for (const path of paths) try { await access(path); return path; } catch { /* Try the next known installation. */ }
  return null;
}

export async function createRenderer() {
  const executablePath = await browserExecutable();
  if (!executablePath) throw new Error("No se encontró Chrome/Chromium/Edge. El modo estático sigue disponible; instala un navegador compatible para render=js.");
  const { chromium } = await import("playwright-core");
  // A local deny proxy is a second boundary for traffic not handled by routes.
  // It never forwards HTTP or CONNECT to any destination.
  const denyProxy = createServer((_, response) => { response.writeHead(403); response.end(); });
  denyProxy.on("connect", (_, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => { denyProxy.once("error", reject); denyProxy.listen(0, "127.0.0.1", () => resolve()); });
  const address = denyProxy.address();
  if (!address || typeof address === "string") { denyProxy.close(); throw new Error("No se pudo aislar la red del navegador."); }
  const closeProxy = async () => {
    denyProxy.closeAllConnections();
    await new Promise<void>(resolve => denyProxy.close(() => resolve()));
  };
  let browser: Browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true,
      proxy: { server: `http://127.0.0.1:${address.port}`, bypass: "<-loopback>" },
      args: ["--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND",
        "--disable-blink-features=WebTransport", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
  } catch (error) { await closeProxy(); throw error; }
  return {
    close: async () => { try { await browser.close(); } finally { await closeProxy(); } },
    async render(url: string, initial: RenderResource, request: (url: string, signal: AbortSignal, remainingBytes: number) => Promise<RenderResource>): Promise<RenderResult> {
      // No persistent profile, no existing login, no direct browser network. Every HTTP
      // response is fulfilled using the crawler's validated/pinned transport instead.
      const context = await browser.newContext({ serviceWorkers: "block", offline: true,
        acceptDownloads: false, viewport: { width: 1365, height: 768 }, userAgent: "SEO-Webmaster-MCP/1.0" });
      const controller = new AbortController();
      const deadline = setTimeout(() => { controller.abort(); void context.close().catch(() => {}); }, 25_000);
      const result: RenderResult = { html: initial.body, status: "complete", requests: 0, errors: [] };
      let bytes = 0;
      let resourceQueue = Promise.resolve();
      const error = (target: string, message: string) => {
        result.status = "partial";
        if (result.errors.length < 20) result.errors.push({ url: target, error: message });
      };
      try {
        await context.addInitScript(() => {
          for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport", "Worker", "SharedWorker"]) {
            Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
          }
        });
        await context.routeWebSocket("**/*", socket => { error(socket.url(), "WebSocket bloqueado en el renderizado de lectura."); socket.close(); });
        await context.route("**/*", async route => {
          const target = route.request().url();
          if (!["document", "script", "stylesheet", "xhr", "fetch"].includes(route.request().resourceType())) {
            await route.abort().catch(() => {}); return;
          }
          const previous = resourceQueue;
          let release!: () => void;
          resourceQueue = new Promise<void>(resolve => { release = resolve; });
          try {
            await previous;
            if (route.request().method() !== "GET") throw new Error("El renderizado de lectura solo permite GET.");
            if (route.request().resourceType() === "document" && target !== url) throw new Error("No se permiten subdocumentos ni navegación adicional durante el renderizado.");
            if (!/^https?:\/\//i.test(target)) throw new Error("Protocolo no permitido en recursos del renderizado.");
            if (++result.requests > 100 || bytes >= 20_000_000) throw new Error("Límite de recursos del renderizado alcanzado.");
            // Serialize acquisition to enforce a shared byte budget across resources.
            if (controller.signal.aborted || bytes >= 20_000_000) throw new Error("Renderizado finalizado o límite de bytes alcanzado.");
            const resource = target === url ? initial : await request(target, controller.signal, 20_000_000 - bytes);
            bytes += Buffer.byteLength(resource.body);
            if (bytes > 20_000_000) throw new Error("Límite de bytes del renderizado alcanzado.");
            if (resource.status >= 400) error(target, `Recurso de renderizado con HTTP ${resource.status}.`);
            const headers = { ...resource.headers };
            for (const name of ["content-length", "content-encoding", "transfer-encoding", "set-cookie", "connection"]) delete headers[name];
            await route.fulfill({ status: resource.status, headers, contentType: resource.contentType || "text/plain", body: resource.body });
          } catch (reason) {
            error(target, reason instanceof Error ? reason.message : "No se pudo obtener el recurso.");
            await route.abort().catch(() => {});
          } finally { release(); }
        });
        const page = await context.newPage();
        context.on("page", popup => { if (popup !== page) void popup.close().catch(() => {}); });
        page.on("dialog", dialog => { void dialog.dismiss().catch(() => {}); });
        page.on("pageerror", () => error(url, "El JavaScript de la página produjo un error durante el renderizado."));
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        try { await page.waitForLoadState("networkidle", { timeout: 5_000 }); }
        catch { error(url, "La página no terminó sus peticiones dentro del tiempo de espera."); }
        result.html = await page.content();
        if (Buffer.byteLength(result.html) > 2_000_000) throw new Error("DOM renderizado demasiado grande para la auditoría.");
        return result;
      } finally {
        clearTimeout(deadline);
        controller.abort();
        await context.close();
      }
    },
  };
}
