import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeHtml, crawlSite, sitemapLocations } from "../dist/crawl.js";

test("sitemap y HTML producen evidencia técnica sin depender de APIs", () => {
  const sitemap = sitemapLocations('<urlset><url><loc>https://example.com/a</loc></url></urlset>');
  assert.deepEqual(sitemap.pages, ["https://example.com/a"]);
  const page = analyzeHtml("https://example.com/a", "https://example.com/a", 200, 0,
    '<html><head><title>Prueba</title><link rel="canonical" href="/a"><meta name="robots" content="noindex"></head><body><main><h1>Hola</h1><a href="/b">B</a></main></body></html>');
  assert.equal(page.noindex, true);
  assert.equal(page.canonical, "https://example.com/a");
  assert.deepEqual(page.links, ["https://example.com/b"]);
});

test("rastreo rechaza destinos locales", async () => {
  await assert.rejects(() => crawlSite("http://127.0.0.1/"), /públicas/);
});

test("CSV GEO queda separado por propiedad y rechaza métricas inválidas", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "seo-geo-"));
  const original = process.env.XDG_CONFIG_HOME;
  const originalAppdata = process.env.APPDATA;
  process.env.XDG_CONFIG_HOME = temporary;
  process.env.APPDATA = temporary;
  const { importGeoReport, geoReportSummary } = await import("../dist/geo.js");
  try {
    const file = join(temporary, "export.csv");
    await writeFile(file, "Page,Impressions\nhttps://example.com/a,12\nhttps://example.com/b,~\n");
    await importGeoReport({ file, siteUrl: "sc-domain:example.com", startDate: "2026-09-01",
      endDate: "2026-09-24", dimension: "page" });
    const report = await geoReportSummary({ siteUrl: "sc-domain:example.com" });
    assert.equal(report.rows[0].impressions, 12);
    assert.equal(report.totalImpressions, null);
    assert.equal((await geoReportSummary({ siteUrl: "sc-domain:other.com" })).status, "not_imported");
    await writeFile(file, "Page,Impressions\nhttps://example.com/a,-3\n");
    await assert.rejects(() => importGeoReport({ file, siteUrl: "sc-domain:example.com",
      startDate: "2026-09-01", endDate: "2026-09-24", dimension: "page" }), /inválida/);
  } finally {
    if (original === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = original;
    if (originalAppdata === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppdata;
    await rm(temporary, { recursive: true, force: true });
  }
});
