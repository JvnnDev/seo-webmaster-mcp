import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { pageSpeedReport } from "../dist/performance.js";
import { seoAuditAdvanced } from "../dist/advanced.js";

const baseUrl = "https://audit.example/";
const fixture = {
  id: baseUrl, analysisUTCTimestamp: "2026-10-20T12:00:00.000Z",
  lighthouseResult: {categories: {performance: {score: 0.72}}, audits: {
    "largest-contentful-paint": {numericValue: 2450}, "cumulative-layout-shift": {numericValue: 0.02},
    "total-blocking-time": {numericValue: 123}, "first-contentful-paint": {numericValue: 1100},
  }},
  originLoadingExperience: {id: "https://audit.example", metrics: {
    LARGEST_CONTENTFUL_PAINT_MS: {percentile: 1800}, INTERACTION_TO_NEXT_PAINT: {percentile: 180},
    CUMULATIVE_LAYOUT_SHIFT_SCORE: {percentile: 8},
  }},
};
async function network(pageSpeed, run) {
  const previousFetch = globalThis.fetch, previousLookup = dns.lookup;
  const requests = [];
  dns.lookup = async () => [{address: "93.184.216.34", family: 4}]; syncBuiltinESMExports();
  globalThis.fetch = async input => {
    const url = new URL(input); requests.push(url);
    if (url.hostname === "www.googleapis.com") return pageSpeed(url);
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow:\n");
    if (url.pathname.startsWith("/sitemap")) return new Response("<urlset/>");
    return new Response('<html lang="es"><head><title>Real</title><meta name="description" content="Descripción"><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://audit.example/"></head><body><h1>Contenido</h1></body></html>', {headers: {"content-type": "text/html"}});
  };
  try { await run(requests); }
  finally { globalThis.fetch = previousFetch; dns.lookup = previousLookup; syncBuiltinESMExports(); }
}

test("PageSpeed separa laboratorio de campo, URL de origen y convierte las unidades CLS de PSI", async () => {
  await network(url => {
    assert.equal(url.searchParams.get("strategy"), "mobile");
    assert.equal(url.searchParams.get("url"), baseUrl);
    return Response.json(fixture);
  }, async () => {
    const report = await pageSpeedReport(baseUrl);
    assert.equal(report.lab.performanceScore, 72);
    assert.equal(report.lab.metrics.lcpMs, 2450);
    assert.equal(report.lab.metrics.cls, 0.02);
    assert.equal(report.field.url.available, false);
    assert.equal(report.field.url.p75.lcpMs, null);
    assert.equal(report.field.origin.available, true);
    assert.equal(report.field.origin.p75.cls, 0.08);
    assert.equal(report.field.origin.p75.inpMs, 180);
    assert(report.limitations.some(text => text.includes("laboratorio")));
  });
});

test("rendimiento ausente no se presenta como cero o como una buena medición", async () => {
  await network(() => Response.json({lighthouseResult: {categories: {performance: {score: null}}, audits: {}}}), async () => {
    const report = await pageSpeedReport(baseUrl);
    assert.equal(report.lab.performanceScore, null);
    assert.equal(report.lab.metrics.lcpMs, null);
    assert.equal(report.field.origin.available, false);
    assert.equal(report.field.url.available, false);
  });
});

test("fallos de cuota, JSON, Lighthouse y tamaños conservan errores sin exponer claves", async () => {
  const previousKey = process.env.PAGESPEED_API_KEY;
  process.env.PAGESPEED_API_KEY = "fixture-api-key-not-for-logs";
  try {
    for (const response of [() => new Response(null, {status: 429}), () => new Response("not json"),
      () => Response.json({lighthouseResult: {runtimeError: {code: "NO_FCP"}}}),
      () => new Response(new Uint8Array(8_000_001))]) await network(response, async () => {
      await assert.rejects(() => pageSpeedReport(baseUrl), error => !error.message.includes("fixture-api-key-not-for-logs"));
    });
  } finally { if (previousKey === undefined) delete process.env.PAGESPEED_API_KEY; else process.env.PAGESPEED_API_KEY = previousKey; }
});

test("rendimiento es explícito y un fallo conserva el informe HTML como parcial", async () => {
  await network(() => Response.json(fixture), async requests => {
    const staticReport = await seoAuditAdvanced({baseUrl, maxPages: 1});
    assert.equal(staticReport.performance, null);
    assert(!requests.some(url => url.hostname === "www.googleapis.com"));
    const measured = await seoAuditAdvanced({baseUrl, maxPages: 1, performance: true});
    assert.equal(measured.status, "complete");
    assert.equal(measured.performance.lab.performanceScore, 72);
    assert(measured.summary.checksPerformed.some(text => text.includes("PageSpeed")));
  });
  await network(() => new Response(null, {status: 429}), async () => {
    const partial = await seoAuditAdvanced({baseUrl, maxPages: 1, performance: true});
    assert.equal(partial.status, "partial");
    assert.equal(partial.summary.htmlPagesAnalyzed, 1);
    assert.equal(partial.performance, null);
    assert(partial.errors.some(error => error.source === "pagespeed"));
  });
});
