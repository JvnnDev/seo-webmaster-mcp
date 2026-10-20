// Synthetic DNS and HTTP for the offline demo and its MCP integration tests.
// Every other destination fails; no request can leave this process.
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { readFile } from "node:fs/promises";

dns.lookup = async (hostname) => {
  if (hostname !== "audit.example") throw new Error("DNS fuera de la demo: " + hostname);
  return [{ address: "93.184.216.34", family: 4 }];
};
syncBuiltinESMExports();

globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (url.origin !== "https://audit.example") throw new Error("Petición fuera de la demo: " + url);
  if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow:\n");
  if (["/sitemap.xml", "/sitemap-index.xml"].includes(url.pathname)) {
    return new Response("<urlset/>", { headers: { "content-type": "application/xml" } });
  }
  const file = { "/before.html": "before.html", "/after.html": "after.html" }[url.pathname];
  if (!file) throw new Error("Ruta fuera de la demo: " + url.pathname);
  return new Response(await readFile(new URL(file, import.meta.url), "utf8"), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};
