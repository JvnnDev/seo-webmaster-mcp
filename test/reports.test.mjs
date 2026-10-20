import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeHtml } from "../dist/crawl.js";
import { runChecks } from "../dist/checks.js";
import { internalLinkGraph } from "../dist/checks-links.js";
import { compareReports, comparisonMarkdown, listReports, readReport, reportMarkdown, reportsDirectory, saveReport, validateReport } from "../dist/reports.js";

const base = "https://audit.example/";
const html = (title = "Título", extra = "", body = "") => `<html lang="es"><head><title>${title}</title><meta name="description" content="Descripción"><meta name="viewport" content="width=device-width"><link rel="canonical" href="${base}">${extra}</head><body><h1>Contenido</h1>${body}</body></html>`;
const page = (path = "", source = html()) => analyzeHtml(base + path, base + path, 200, 0, source);
function report(pages, { modules, sitemapUrls = [], ...overrides } = {}) {
  const checks = runChecks({ pages, sitemapUrls }, modules);
  return { schemaVersion: 1, engineVersion: "1", generatedAt: "2026-10-20T12:00:00.000Z", baseUrl: base,
    status: "complete", summary: { message: "Muestra analizada", htmlPagesAnalyzed: pages.filter(p => p.status === 200 && p.isHtml).length,
      crawlTruncated: false, checksPerformed: ["Pruebas de HTML"], notChecked: ["JavaScript"] },
    actions: checks.actions, checks: checks.results, errors: checks.errors, ...overrides };
}
const has = (report, code) => report.actions.some(action => action.code === code);

test("comparación clasifica correcciones y regresiones por URL y conserva más de 20 ocurrencias", () => {
  const before = report(Array.from({length: 25}, (_, index) => page(String(index), html("", "", '<img src="photo.jpg">'))));
  const after = report(Array.from({length: 25}, (_, index) => page(String(index), html(""))));
  const compared = compareReports(before, after);
  assert.equal(compared.resolved.filter(item => item.code === "images_missing_alt").length, 25);
  assert.equal(compared.persistent.filter(item => item.code === "missing_title").length, 25);
  assert.equal(before.actions.find(action => action.code === "images_missing_alt").affectedUrls.length, 20);
  const regression = compareReports(after, before);
  assert.equal(regression.new.filter(item => item.code === "images_missing_alt").length, 25);
  assert(compared.resolved.every(item => item.module && item.url && item.reason));
});

test("URLs omitidas, respuestas fallidas, redirecciones y reglas cambiadas nunca son correcciones", () => {
  const before = report([page("", html(""))]);
  const cases = [
    report([]),
    report([{...page(), status: 0, isHtml: false, error: "Offline"}], {status: "partial"}),
    report([{...page(), status: 404}]),
    report([{...page(), finalUrl: base + "different"}]),
    {...report([page()]), checks: []},
    (() => { const value = report([page()]); value.checks[0].version++; return value; })(),
  ];
  for (const after of cases) {
    const diff = compareReports(before, after);
    assert(!diff.resolved.some(item => item.code === "missing_title"));
    assert(diff.notComparable.some(item => item.code === "missing_title"));
  }
  assert.throws(() => compareReports(before, {...before, baseUrl: "https://other.example/"}), /mismo origen/);
  assert.throws(() => compareReports(before, {...before, generatedAt: "2026-10-19T12:00:00.000Z"}), /anterior/);
});

test("las reglas aisladas conservan resultados válidos y sus fallos impiden declarar correcciones", () => {
  const good = {id: "fixture", version: 1, scope: "page", run: context => runChecks(context).actions};
  const bad = {...good, run: () => { throw new Error("fallo de regla"); }};
  const before = report([page("", html(""))], {modules: [good]});
  const after = report([page()], {modules: [bad]});
  assert.equal(after.checks[0].status, "error");
  assert.match(after.errors[0].error, /fallo de regla/);
  assert.equal(compareReports(before, after).resolved.length, 0);
  const mixed = runChecks({pages: [page()], sitemapUrls: []}, [bad, {...good, id: "valid"}]);
  assert.equal(mixed.results[1].status, "complete");
  assert.equal(mixed.errors.length, 1);
});

test("los enlaces rotos se comparan al reparar su destino; destinos omitidos quedan no comparables", () => {
  const source = page("", html("Inicio", "", '<a href="/broken">Enlace</a>'));
  const failed = {...page("broken"), status: 404};
  const before = report([source, failed]);
  const repaired = report([source, page("broken")]);
  assert(compareReports(before, repaired).resolved.some(item => item.code === "broken_internal_links"));
  assert(compareReports(before, report([source])).notComparable.some(item => item.code === "broken_internal_links"));
  assert(!compareReports(before, report([source])).resolved.some(item => item.code === "broken_internal_links"));
});

test("el grafo distingue destinos observados y evita inflar enlaces por alias o autoenlaces", () => {
  const source = page("", html("Inicio", "", '<a href="/a">A</a><a href="/a#section">A repetida</a><a href="/unseen">Fuera de muestra</a><a href="/">Inicio</a>'));
  const target = page("a");
  const graph = internalLinkGraph({pages: [source, {...source, url: base + "alias"}, target], sitemapUrls: [base + "a"]});
  assert.equal(graph.nodes.find(node => node.url === base + "a").inboundFromSample, 1);
  assert.equal(graph.nodes.find(node => node.url === base + "a").inSitemap, true);
  assert.equal(graph.nodes.find(node => node.url === base).inboundFromSample, 0);
  assert(graph.edges.some(edge => edge.target === base + "unseen" && edge.targetObserved === false));
  assert.equal(graph.truncated, false);
});

test("la comparación ignora acciones de proveedores y rechaza formatos incompatibles", () => {
  const before = report([page()]);
  before.actions.push({...before.actions[0], code: "google_fixture", title: "Proveedor", priority: "medium", confidence: "verified", affectedUrls: [], steps: ["Consultar"], verification: "Consultar"});
  assert.equal(compareReports(before, report([page()])).resolved.length, 0);
  assert.throws(() => validateReport({...before, schemaVersion: 99}), /incompatible/);
  assert.throws(() => validateReport({...before, checks: [...before.checks, before.checks[0]]}), /duplicadas/);
});

test("una comparación sin hallazgos sigue declarando cambios de reglas y ausencia de cobertura", () => {
  const before = report([page()]), after = report([page()]);
  after.checks[0].version++;
  const changed = compareReports(before, after);
  assert.equal(changed.summary.new, 0);
  assert(changed.summary.incompleteChecks.includes("checks-html"));
  assert.match(comparisonMarkdown(changed), /Comparación limitada/);
  assert.equal(compareReports(report([]), report([])).summary.noHtmlCoverage, true);
  assert.equal(compareReports(before, report([page(), page("extra")])).summary.coverageChanged, true);
});

test("canonical, encabezados y tarjetas sociales distinguen evidencia de revisión contextual", () => {
  const value = report([page("", html("Título", '<link rel="alternate CANONICAL" href="/b"><meta property="og:title" content="Título"><meta property="og:image" content="/relative.jpg">', '<h3>Detalle</h3>'))]);
  for (const code of ["multiple_canonicals", "heading_level_skips", "incomplete_open_graph", "invalid_social_url"]) assert(has(value, code), code);
  const clean = report([page("", html("Título", '<meta property="og:title" content="Título"><meta property="og:type" content="website"><meta property="og:image" content="https://audit.example/image.jpg"><meta property="og:url" content="https://audit.example/">', '<h1>Segundo principal permitido</h1><h2>Detalle</h2>'))]);
  assert(!has(clean, "multiple_h1"));
  assert(!has(clean, "heading_level_skips"));
  assert(!has(clean, "incomplete_open_graph"));
  assert(!has(report([page()]), "incomplete_open_graph"), "No exigir redes sociales sin marcado social");
});

test("hreflang valida formatos y reciprocidad solo sobre páginas comprobadas", () => {
  const esLinks = '<link rel="alternate" hreflang="es" href="https://audit.example/"><link rel="alternate" hreflang="en" href="https://audit.example/en">';
  const es = page("", html("Español", esLinks));
  const english = page("en", html("English"));
  const before = report([es, english]);
  assert(has(before, "hreflang_missing_return"));
  const after = report([es, page("en", html("English", esLinks))]);
  assert(!has(after, "hreflang_missing_return"));
  assert(compareReports(before, after).resolved.some(item => item.code === "hreflang_missing_return"));
  const omitted = report([es]);
  assert(!has(omitted, "hreflang_missing_return"));
  assert(omitted.checks.find(check => check.id === "checks-hreflang").unverifiedUrls.includes(base));
  assert(compareReports(before, omitted).notComparable.some(item => item.code === "hreflang_missing_return"));
  assert(!has(report([page()]), "hreflang_missing_self"));
  assert(has(report([page("", html("Título", '<link rel="alternate" hreflang="not_a_language" href="/en">'))]), "invalid_hreflang"));
});

test("schema.org inspecciona @graph y tipos explícitos sin evaluar contextos personalizados", () => {
  const json = data => '<script type="application/ld+json">' + JSON.stringify(data) + '</script>';
  const value = report([page("", html("Producto", json({"@context": "https://schema.org", "@graph": [
    {"@type": "Product", offers: {"@type": "Offer", price: "12.00"}},
    {"@type": "Article"},
    {"@type": "BreadcrumbList", itemListElement: [{position: 1}, {position: 1}]},
  ]})))]);
  assert(has(value, "schema_properties_review"));
  const issues = value.actions.find(action => action.code === "schema_properties_review").evidence.examples[0].observed;
  assert(issues.some(issue => issue.type === "Product" && issue.property === "name"));
  assert(issues.some(issue => issue.type === "Offer" && issue.property === "priceCurrency"));
  assert(issues.some(issue => issue.type === "Article" && issue.property === "headline"));
  assert(issues.some(issue => issue.type === "BreadcrumbList"));
  const custom = report([page("", html("Otro", json({"@context": "https://custom.example", "@type": "Product"})))]);
  assert(!has(custom, "schema_properties_review"));
  const repaired = report([page("", html("Producto", json({"@context": "https://schema.org", "@type": "Product", name: "Real", offers: {"@type": "Offer", price: 12, priceCurrency: "PEN"}})))]);
  assert(!has(repaired, "schema_properties_review"));
  assert(compareReports(value, repaired).resolved.some(item => item.code === "schema_properties_review"));
});

test("JSON-LD grande o profundamente anidado conserva el HTTP y declara límites sin falsos resueltos", () => {
  const json = data => '<script type="application/ld+json">' + JSON.stringify(data) + '</script>';
  const before = report([page("", html("Producto", json({"@context": "https://schema.org", "@type": "Product"})))]);
  const large = page("", html("Producto", json({"@context": "https://schema.org", "@graph": Array.from({length: 100000}, () => ({}))})));
  assert.equal(large.status, 200);
  assert.equal(large.details.schema.truncated, true);
  assert.equal(compareReports(before, report([large])).resolved.filter(item => item.code === "schema_properties_review").length, 0);
  const nested = '{"@context":' + '['.repeat(1000) + '"https://schema.org"' + ']'.repeat(1000) + ',"@type":"Product"}';
  const deeplyNested = page("", html("Producto", '<script type="application/ld+json">' + nested + '</script>'));
  assert.equal(deeplyNested.status, 200);
  assert.equal(deeplyNested.details.schema.truncated, true);
});

test("sitemaps y canonical consideran solo destinos observados y distinguen señales intencionales", () => {
  const source = page("", html("Inicio", '<link rel="canonical" href="/bad">'));
  source.canonical = base + "bad";
  const before = report([source, {...page("bad"), noindex: true}], {sitemapUrls: [base]});
  assert(has(before, "canonical_target_unavailable"));
  assert(has(before, "sitemap_indexability_conflict"));
  assert.equal(before.actions.find(action => action.code === "sitemap_indexability_conflict").confidence, "inferred");
  const unknown = report([source]);
  assert(!has(unknown, "canonical_target_unavailable"));
  assert(unknown.checks.find(check => check.id === "checks-canonical-targets").unverifiedUrls.includes(base));
});

test("historial persiste sin leer credenciales, rechaza rutas y conserva exportaciones con evidencia", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "seo-reports-"));
  const keys = ["APPDATA", "XDG_CONFIG_HOME", "HOME"], previous = keys.map(key => process.env[key]);
  keys.forEach(key => process.env[key] = temporary);
  try {
    assert.deepEqual((await listReports()).reports, []);
    await mkdir(dirname(reportsDirectory()), {recursive: true});
    await writeFile(join(dirname(reportsDirectory()), "credentials.json"), "invalid credentials JSON");
    const value = report([page("", html(""))]);
    const saved = await saveReport(value);
    assert.equal((await readReport(saved.id)).report.actions[0].code, "missing_title");
    assert.equal((await listReports()).reports[0].id, saved.id);
    assert.equal((await listReports()).reports[0].htmlPagesAnalyzed, 1);
    await assert.rejects(() => readReport("../../credentials"), /inválido/);
    await assert.rejects(() => listReports(0), /limit/);
    const markdown = reportMarkdown(value);
    assert.match(markdown, /missing|título|título/i);
    assert.match(markdown, /Evidencia:/);
    assert.match(markdown, /JavaScript/);
    assert.match(comparisonMarkdown(compareReports(value, report([page()]))), /Resueltos: 1/);
    const stored = join(reportsDirectory(), saved.id + ".json");
    const corrupt = JSON.parse(await readFile(stored, "utf8"));
    corrupt.id = "wrong";
    await writeFile(stored, JSON.stringify(corrupt));
    await assert.rejects(() => readReport(saved.id), /incompatible|incorrecto/);
    assert.equal((await listReports()).errors.length, 1);
  } finally {
    keys.forEach((key, index) => previous[index] === undefined ? delete process.env[key] : process.env[key] = previous[index]);
    await rm(temporary, {recursive: true, force: true});
  }
});
