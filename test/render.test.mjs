import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { seoAuditAdvanced } from "../dist/advanced.js";
import { browserExecutable } from "../dist/render.js";
import { compareReports } from "../dist/reports.js";

const base = "https://audit.example/";
async function browserAvailable(t) {
  if (await browserExecutable()) return true;
  if (process.env.REQUIRE_BROWSER_TESTS === "1") assert.fail("Se requiere Chrome/Chromium/Edge para las pruebas de navegador de CI");
  t.skip("No hay un navegador compatible instalado; las pruebas estáticas siguen disponibles");
  return false;
}
async function network(run, { script = "document.addEventListener('DOMContentLoaded',()=>{document.title='Creado por JS';document.body.insertAdjacentHTML('beforeend','<h1>Contenido renderizado</h1>');});", csp = "" } = {}) {
  const originalFetch = globalThis.fetch, originalLookup = dns.lookup;
  const requests = [];
  dns.lookup = async hostname => [{address: hostname === "private.example" ? "10.0.0.1" : "93.184.216.34", family: 4}];
  syncBuiltinESMExports();
  globalThis.fetch = async (input, options) => {
    const url = new URL(input); requests.push({url: url.href, method: options?.method || "GET"});
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow:\n");
    if (url.pathname.startsWith("/sitemap")) return new Response("<urlset/>");
    if (url.pathname === "/app.js") return new Response(script, {headers: {"content-type": "application/javascript"}});
    if (url.origin !== "https://audit.example") throw new Error("Destino no previsto por la prueba");
    return new Response('<html lang="es"><head><meta name="description" content="Descripción"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://audit.example/"><script src="https://assets.example/app.js"></script></head><body></body></html>',
      {headers: {"content-type": "text/html", ...(csp ? {"content-security-policy": csp} : {})}});
  };
  try { await run(requests); }
  finally { globalThis.fetch = originalFetch; dns.lookup = originalLookup; syncBuiltinESMExports(); }
}

test("un navegador real audita el DOM tras JS con recursos públicos de CDN y conserva HTML inicial", async t => {
  if (!await browserAvailable(t)) return;
  await network(async requests => {
    const before = await seoAuditAdvanced({baseUrl: base, maxPages: 1});
    assert(before.actions.some(action => action.code === "missing_title"));
    assert(!requests.some(request => request.url.includes("/app.js")), "El modo estático no carga JS");
    const after = await seoAuditAdvanced({baseUrl: base, maxPages: 1, render: "js"});
    assert.equal(after.status, "complete", JSON.stringify(after.errors));
    assert.equal(after.crawl.pages[0].title, "Creado por JS");
    assert.equal(after.crawl.pages[0].h1Count, 1);
    assert.equal(after.crawl.pages[0].rendering.static.title, null);
    assert.equal(after.crawl.pages[0].rendering.status, "complete");
    assert(requests.some(request => request.url === "https://assets.example/app.js"));
    assert(!after.actions.some(action => action.code === "missing_title"));
    assert(compareReports(before, after).notComparable.some(item => item.code === "missing_title"), "Cambiar de modo no debe fingir una corrección");
  });
});

test("el renderizado bloquea IP privada, POST y WebSocket y conserva un informe parcial", async t => {
  if (!await browserAvailable(t)) return;
  await network(async requests => {
    const report = await seoAuditAdvanced({baseUrl: base, maxPages: 1, render: "js"});
    assert.equal(report.status, "partial");
    const page = report.crawl.pages[0];
    assert.equal(page.status, 200);
    assert.equal(page.title, "Render parcial");
    assert.equal(page.rendering.status, "partial");
    assert(page.rendering.errors.some(error => /pública|públicas/.test(error.error)));
    assert(page.rendering.errors.some(error => /GET/.test(error.error)));
    assert(!requests.some(request => request.url.includes("private.example")));
    assert(requests.every(request => request.method === "GET"));
    assert(report.checks.every(check => check.unverifiedUrls.includes(base)));
  }, {script: "document.title='Render parcial';if(typeof RTCPeerConnection!=='undefined'||typeof WebTransport!=='undefined'||typeof Worker!=='undefined')throw new Error('El aislamiento de APIs falló');fetch('https://private.example/secret').catch(()=>{});fetch('/write',{method:'POST',body:'no'}).catch(()=>{});new WebSocket('wss://private.example/socket');"});
});

test("el renderizado conserva CSP y no afirma que el JS bloqueado se ejecutó", async t => {
  if (!await browserAvailable(t)) return;
  await network(async () => {
    const report = await seoAuditAdvanced({baseUrl: base, maxPages: 1, render: "js"});
    assert.equal(report.crawl.pages[0].title, null);
    assert(report.actions.some(action => action.code === "missing_title"));
  }, {csp: "script-src 'none'"});
});

test("render y rendimiento validan opciones antes de crear navegador o pedir servicios", async () => {
  await assert.rejects(() => seoAuditAdvanced({baseUrl: base, render: "automatic"}), /render/);
  await assert.rejects(() => seoAuditAdvanced({baseUrl: base, render: "js", maxPages: 21}), /20/);
  await assert.rejects(() => seoAuditAdvanced({baseUrl: base, performance: "yes"}), /booleano/);
  await assert.rejects(() => seoAuditAdvanced({baseUrl: base, performanceStrategy: "tablet"}), /Strategy/);
});
