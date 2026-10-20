import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("base href resuelve canónicas y enlaces relativos como el documento HTML", () => {
  const page = analyzeHtml("https://example.com/shop/page", "https://example.com/shop/page", 200, 0,
    '<head><base href="/products/"><link rel="canonical" href="item"></head><body><a href="item">Producto</a></body>');
  assert.equal(page.canonical, "https://example.com/products/item");
  assert.deepEqual(page.links, ["https://example.com/products/item"]);
  const external = analyzeHtml("https://example.com/", "https://example.com/", 200, 0,
    '<base href="https://other.example/"><a href="item">Producto</a>');
  assert.deepEqual(external.links, []);
  const invalid = analyzeHtml("https://example.com/shop/", "https://example.com/shop/", 200, 0,
    '<base href="http://["><a href="item">Producto</a>');
  assert.deepEqual(invalid.links, ["https://example.com/shop/item"]);
});

test("robots combina etiquetas y respeta el agente de las cabeceras para Googlebot", () => {
  const cases = [
    ["none", '<meta name="robots" content="none">', "", true, false],
    ["segunda etiqueta restrictiva", '<meta name="robots" content="index"><meta name="robots" content="noindex">', "", true, false],
    ["Googlebot y mayúsculas", '<meta name="ROBOTS" content="all"><meta name="GoogleBot" content="NONE, NOSNIPPET">', "", true, true],
    ["otro agente HTML", '<meta name="otherbot" content="noindex,nosnippet">', "", false, false],
    ["none en cabecera", "", "none", true, false],
    ["solo otro agente", "", "otherbot: noindex, nosnippet, max-snippet: 0", false, false],
    ["Googlebot explícito", "", "otherbot: noindex, GOOGLEBOT: nosnippet", false, true],
    ["cambio de agente", "", "googlebot: noindex, otherbot: nosnippet", true, false],
    ["directiva parametrizada global", "", "max-snippet: 0, googlebot: noindex", true, true],
    ["directiva parametrizada por agente", "", "googlebot: max-snippet: 0, otherbot: noindex", false, true],
    ["Googlebot News no es Googlebot", "", "googlebot-news: noindex, nosnippet", false, false],
    ["regla global y otra específica", "", "noindex, otherbot: nosnippet", true, false],
    ["meta global prevalece", '<meta name="robots" content="noindex">', "otherbot: index", true, false],
    ["valor none de otro parámetro", '<meta name="robots" content="max-image-preview: none">', "", false, false],
    ["snippet positivo con cero inicial", '<meta name="robots" content="max-snippet:01">', "", false, false],
    ["snippet mal formado", '<meta name="robots" content="max-snippet:0invalid">', "", false, false],
    ["reglas separadas por espacios", '<meta name="robots" content="noindex nosnippet">', "", true, true],
    ["dos etiquetas Googlebot", '<meta name="googlebot" content="index"><meta name="googlebot" content="max-snippet: 0">', "", false, true],
  ];
  for (const [label, html, header, noindex, snippetBlocked] of cases) {
    const page = analyzeHtml("https://example.com/", "https://example.com/", 200, 0, html, true, header);
    assert.equal(page.noindex, noindex, label);
    assert.equal(page.snippetBlocked, snippetBlocked, label);
  }
});

test("una canónica inválida conserva el HTTP y el resto de la evidencia HTML", () => {
  for (const href of ["http://[", "javascript:alert(1)", "mailto:seo@example.com"]) {
    const page = analyzeHtml("https://example.com/a", "https://example.com/a", 200, 0,
      `<html lang="es"><head><title>Página útil</title><link rel="canonical" href="${href}"></head>` +
      '<body><h1>Contenido</h1><a href="/b">Otra página</a></body></html>');
    assert.equal(page.status, 200);
    assert.equal(page.isHtml, true);
    assert.equal(page.title, "Página útil");
    assert.equal(page.h1Count, 1);
    assert.deepEqual(page.links, ["https://example.com/b"]);
    assert.equal(page.canonical, null);
    assert.match(page.canonicalError, /URL HTTP\(S\) válida/);
    assert.equal(page.error, undefined);
  }
  const valid = analyzeHtml("https://example.com/a", "https://example.com/a", 200, 0,
    '<link rel="canonical" href="/b">');
  assert.equal(valid.canonical, "https://example.com/b");
  assert.equal(valid.canonicalError, null);
  const absent = analyzeHtml("https://example.com/a", "https://example.com/a", 200, 0, "");
  assert.equal(absent.canonical, null);
  assert.equal(absent.canonicalError, null);
});

test("lang, viewport e imágenes distinguen ausencia de alt vacío y acotan los ejemplos", async () => {
  const before = analyzeHtml("https://audit.example/before.html", "https://audit.example/before.html", 200, 0,
    await readFile(new URL("../examples/before.html", import.meta.url), "utf8"));
  assert.equal(before.lang, null);
  assert.equal(before.viewport, null);
  assert.deepEqual(before.images, { total: 2, missingAlt: 1, examples: [{ imageIndex: 1, src: "./audit-flow.svg" }] });
  const after = analyzeHtml("https://audit.example/after.html", "https://audit.example/after.html", 200, 0,
    await readFile(new URL("../examples/after.html", import.meta.url), "utf8"));
  assert.equal(after.lang, "es");
  assert.equal(after.viewport, "width=device-width, initial-scale=1");
  assert.deepEqual(after.images, { total: 2, missingAlt: 0, examples: [] });
  assert.equal(after.canonical, "https://audit.example/after.html");
  const many = analyzeHtml("https://example.com/", "https://example.com/", 200, 0,
    '<html lang="  "><head><meta name="viewport" content="  "></head><body>' +
    '<img alt=""><img alt="Texto"><img><img src="' + "x".repeat(400) + '">' + '<img src="/photo.png">'.repeat(6) + '</body></html>');
  assert.equal(many.lang, null);
  assert.equal(many.viewport, null);
  assert.equal(many.images.total, 10);
  assert.equal(many.images.missingAlt, 8);
  assert.equal(many.images.examples.length, 5);
  assert.deepEqual(many.images.examples[0], { imageIndex: 3, src: null });
  assert.equal(many.images.examples[1].src.length, 300);
  const duplicateViewport = analyzeHtml("https://example.com/", "https://example.com/", 200, 0,
    '<head><meta name="viewport" content=" "><meta name="VIEWPORT" content="width=device-width"></head>');
  assert.equal(duplicateViewport.viewport, "width=device-width");
  const nonHtml = analyzeHtml("https://example.com/data", "https://example.com/data", 200, 0, "", false);
  assert.deepEqual(nonHtml.images, { total: 0, missingAlt: 0, examples: [] });
});

test("JSON-LD comprueba cada bloque sin confundir sintaxis con semántica", () => {
  const blocks = [
    { "@context": "https://schema.org", "@type": "Organization" },
    [{ "@type": "Person", name: "Ana" }, { "@type": "WebSite" }],
    { "@context": "https://schema.org", "@graph": [{ "@type": "Article" }] },
    {}, [],
  ];
  const html = blocks.map((block) => `<script type="application/ld+json">${JSON.stringify(block)}</script>`).join("");
  const page = analyzeHtml("https://example.com/", "https://example.com/", 200, 0, html);
  assert.equal(page.structuredData, true);
  assert.deepEqual(page.jsonLdBlocks, blocks.map((_, index) => ({ scriptIndex: index + 1, status: "parsed" })));
  const absent = analyzeHtml("https://example.com/", "https://example.com/", 200, 0,
    '<script type="application/json">{"app":true}</script>');
  assert.equal(absent.structuredData, false);
  assert.deepEqual(absent.jsonLdBlocks, []);
});

test("JSON-LD mal formado o raíz inválida expone el bloque sin copiar su contenido", () => {
  const blocks = ['{"name":"private-value",}', "", "null", '"text"', "42", "true", '[{},"text"]'];
  const html = blocks.map((block) => `<script type="application/ld+json">${block}</script>`).join("");
  const page = analyzeHtml("https://example.com/", "https://example.com/", 200, 0, html);
  assert.deepEqual(page.jsonLdBlocks.map((block) => block.status),
    ["invalid_json", "invalid_json", "invalid_root", "invalid_root", "invalid_root", "invalid_root", "invalid_root"]);
  assert(page.jsonLdBlocks.every((block, index) => block.scriptIndex === index + 1 && block.error));
  assert(!JSON.stringify(page.jsonLdBlocks).includes("private-value"));
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
    assert.equal(report.rows[1].impressions, null);
    assert.equal(report.unknownImpressionRows, 1);
    assert.equal(report.totalImpressions, null);
    assert.equal((await geoReportSummary({ siteUrl: "sc-domain:other.com" })).status, "not_imported");
    for (const value of ["-3", "", "1.5", "1e309"]) {
      await writeFile(file, `Page,Impressions\nhttps://example.com/a,${value}\n`);
      await assert.rejects(() => importGeoReport({ file, siteUrl: "sc-domain:example.com",
        startDate: "2026-09-01", endDate: "2026-09-24", dimension: "page" }), /inválida/);
    }
    await writeFile(file, "Page,Impressions\nhttps://[,12\n");
    await assert.rejects(() => importGeoReport({ file, siteUrl: "sc-domain:example.com",
      startDate: "2026-09-01", endDate: "2026-09-24", dimension: "page" }), /URL GEO inválida/);
    await writeFile(file, "Date,Impressions\n2026-09-01,12\n2026-09-02,~\n2026-09-03,-\n");
    await importGeoReport({ file, siteUrl: "sc-domain:example.com",
      startDate: "2026-09-01", endDate: "2026-09-24", dimension: "date" });
    const unknown = await geoReportSummary({ siteUrl: "sc-domain:example.com" });
    assert.equal(unknown.totalImpressions, null);
    assert.equal(unknown.unknownImpressionRows, 2);
    for (const date of ["2026-02-30", "2026-10-01"]) {
      await writeFile(file, `Date,Impressions\n${date},12\n`);
      await assert.rejects(() => importGeoReport({ file, siteUrl: "sc-domain:example.com",
        startDate: "2026-01-01", endDate: "2026-09-24", dimension: "date" }), /Fecha GEO inválida/);
    }
    await writeFile(file, "Date,Impressions\n2026-09-01,12\n2026-09-02,0\n");
    await importGeoReport({ file, siteUrl: "sc-domain:example.com",
      startDate: "2026-09-01", endDate: "2026-09-24", dimension: "date" });
    const known = await geoReportSummary({ siteUrl: "sc-domain:example.com" });
    assert.equal(known.totalImpressions, 12);
    assert.equal(known.unknownImpressionRows, 0);
  } finally {
    if (original === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = original;
    if (originalAppdata === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppdata;
    await rm(temporary, { recursive: true, force: true });
  }
});
