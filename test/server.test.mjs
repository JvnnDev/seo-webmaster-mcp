import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const require = createRequire(import.meta.url);
const temporaryCredentialsPath = (temporary) => join(
  process.platform === "darwin" ? join(temporary, "Library", "Application Support") : temporary,
  "seo-webmaster-mcp",
  "credentials.json",
);

// Keep crawl fixtures deterministic and offline, including DNS safety checks.
const crawlMock = `
  import dns from "node:dns/promises";
  import { syncBuiltinESMExports } from "node:module";
  dns.lookup = async (hostname) => {
    if (hostname === "private.example") return [{ address: "127.0.0.1", family: 4 }];
    if (hostname !== "audit.example") throw new Error("DNS inesperado: " + hostname);
    return [{ address: "93.184.216.34", family: 4 }];
  };
  syncBuiltinESMExports();
  let fixableVisits = 0;
  let jsonLdVisits = 0;
  const mockCrawlFetch = (input) => {
    const url = new URL(input);
    if (url.hostname !== "audit.example") return null;
    const response = (body, status = 200, type = "text/html", headers = {}) => new Response(body,
      { status, headers: { "content-type": type, ...headers } });
    if (url.pathname === "/robots.txt") return response("User-agent: *\\nDisallow: /blocked", 200, "text/plain");
    if (url.pathname === "/sitemap.xml" || url.pathname === "/sitemap-index.xml")
      return response("<urlset/>", 200, "application/xml");
    if (url.pathname === "/blocked") throw new Error("Se rastreó una URL excluida");
    if (url.pathname === "/offline") throw new Error("Conexión interrumpida");
    if (url.pathname === "/broken") return response("Missing", 404);
    if (url.pathname === "/nonhtml") return response('{"data":true}', 200, "application/json");
    const title = url.pathname === "/fixable" && ++fixableVisits === 1 ? "" :
      "<title>" + (url.pathname === "/" || url.pathname === "/duplicate" ? "Duplicado" : "Página útil") + "</title>";
    const links = url.pathname === "/" ? '<a href="/duplicate">Otra página</a><a href="/broken">Enlace roto</a><a href="/blocked">Excluida</a>' :
      url.pathname === "/many" ? Array.from({ length: 24 }, (_, i) => '<a href="/many/' + i + '">Página</a>').join("") : "";
    const metadata = url.pathname === "/review" ? '<meta name="robots" content="noindex">' :
      '<meta name="description" content="Descripción"><link rel="canonical" href="' +
        (url.pathname === "/invalid-canonical" ? "http://[" : url.href) + '">';
    const jsonLd = url.pathname === "/jsonld-fixable" ? '<script type="application/ld+json">' +
      (++jsonLdVisits === 1 ? '{"@type":"Organization",}' : '{"@type":"Organization"}') + '</script>' : "";
    const many = url.pathname.startsWith("/many");
    const robots = url.pathname === "/robots-none" ? '<meta name="robots" content="none">' :
      url.pathname === "/robots-repeated" ? '<meta name="robots" content="index"><meta name="robots" content="noindex">' : "";
    const headers = url.pathname === "/robots-scoped" ? { "x-robots-tag": "otherbot: noindex, nosnippet" } : {};
    return response('<html' + (many ? "" : ' lang="es"') + '><head>' + title + metadata + jsonLd + robots +
      (many ? "" : '<meta name="viewport" content="width=device-width, initial-scale=1">') +
      '</head><body><h1>Contenido</h1>' + (many ? '<img src="/photo.png">' : "") + links + '</body></html>', 200, "text/html", headers);
  };
`;

test("contrato MCP, fechas y ausencia de datos de Bing", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "seo-webmaster-mcp-"));
  const configPath = temporaryCredentialsPath(temporary);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ bingApiKey: "test-key" }));

  const mock = crawlMock + `globalThis.fetch = async (url) => {
    const page = mockCrawlFetch(url);
    if (page) return page;
    if (url.searchParams.get("apikey") !== "test-key") throw new Error("clave inesperada");
    const method = url.pathname.split("/").at(-1);
    const day = (date, clicks, impressions) => ({ Date: "/Date(" + Date.parse(date + "T00:00:00Z") + "+0000)/", Clicks: clicks, Impressions: impressions });
    const d = method === "GetUserSites"
      ? [{ Url: "https://test.example/", IsVerified: true, AuthenticationCode: "do-not-expose" }]
      : method === "GetRankAndTrafficStats"
        ? url.searchParams.get("siteUrl") === "https://empty.example/" ? [] : [day("2026-09-01", 0, 5), day("2026-09-02", 3, 9)]
        : method === "GetPageStats" ? [{ Query: "https://test.example/page", Date: "/Date(1788220800000+0000)/", Clicks: 2, Impressions: 10 }]
        : method === "GetLinkCounts" ? { Links: [], TotalPages: 0 }
        : [];
    return new Response(JSON.stringify({ d }), { status: 200, headers: { "content-type": "application/json" } });
  };`;
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(mock)}`, serverPath],
    env: { ...process.env, APPDATA: temporary, XDG_CONFIG_HOME: temporary, HOME: temporary },
  });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return { isError: Boolean(response.isError), value: JSON.parse(response.content[0].text) };
  };

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 29);
    assert(listed.tools.every((tool) => tool.annotations?.readOnlyHint === (tool.name !== "seo_audit_save") && tool.annotations.destructiveHint === false));
    assert(listed.tools.some((tool) => tool.name === "gsc_search_performance"));

    const sites = await call("bing_list_sites");
    assert.deepEqual(sites.value.sites, [{ siteUrl: "https://test.example/", isVerified: true }]);
    assert(!JSON.stringify(sites.value).includes("do-not-expose"));

    const performance = await call("get_bing_clicks_and_impressions", {
      siteUrl: "https://test.example/", startDate: "2026-09-01", endDate: "2026-09-02",
    });
    assert.equal(performance.value.status, "ok");
    assert.deepEqual(performance.value.totals, { clicks: 3, impressions: 14 });
    assert.equal(performance.value.daily[0].clicks, 0);

    const empty = await call("get_bing_clicks_and_impressions", {
      siteUrl: "https://empty.example/", startDate: "2026-09-01", endDate: "2026-09-02",
    });
    assert.equal(empty.value.status, "no_data_from_bing");
    assert.equal(empty.value.totals, null);

    const topPages = await call("bing_top_pages", { siteUrl: "https://test.example/" });
    assert.equal(topPages.value.rows[0].page, "https://test.example/page");

    const invalid = await call("get_bing_clicks_and_impressions", {
      siteUrl: "https://test.example/", startDate: "2026-02-30", endDate: "2026-03-01",
    });
    assert.equal(invalid.isError, true);

    const google = await call("gsc_list_sites");
    assert.equal(google.isError, true);
    assert.match(google.value.error, /setup google/);

    const audit = await call("seo_audit_site", {
      bingSiteUrl: "https://test.example/", startDate: "2026-09-01", endDate: "2026-09-02",
    });
    assert.equal(audit.value.status, "complete");
    assert.deepEqual(audit.value.bing.performance.totals, { clicks: 3, impressions: 14 });
    assert(audit.value.findings.some((finding) => finding.code === "bing_no_sitemaps"));

    const advanced = await call("seo_audit_advanced", {
      baseUrl: "https://audit.example/clean", bingSiteUrl: "https://test.example/",
      startDate: "2026-09-01", endDate: "2026-09-02",
    });
    assert.equal(advanced.value.status, "complete");
    assert.deepEqual(advanced.value.official.bing.performance.totals, { clicks: 3, impressions: 14 });
    assert.equal(advanced.value.crawl.pageCount, 1);

    const partial = await call("seo_audit_advanced", {
      baseUrl: "https://audit.example/clean", bingSiteUrl: "https://test.example/",
      gscSiteUrl: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-02",
    });
    assert.equal(partial.value.status, "partial");
    assert.deepEqual(partial.value.official.bing.performance.totals, { clicks: 3, impressions: 14 });
    assert.equal(partial.value.crawl.pageCount, 1);
    assert(partial.value.errors.some((error) => error.source === "google.performance" && /setup google/.test(error.error)));
  } finally {
    await client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("consultas de Search Console con OAuth simulado", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "seo-webmaster-gsc-"));
  const configPath = temporaryCredentialsPath(temporary);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    google: { clientId: "client", clientSecret: "secret", refreshToken: "refresh" },
  }));

  const googleLibraryUrl = pathToFileURL(require.resolve("google-auth-library")).href;
  const mock = crawlMock + `
    import { OAuth2Client } from ${JSON.stringify(googleLibraryUrl)};
    OAuth2Client.prototype.getRequestHeaders = async () => new Headers({ authorization: "Bearer test-token" });
    globalThis.fetch = async (url, options) => {
      const page = mockCrawlFetch(url);
      if (page) return page;
      if (options.headers.Authorization !== "Bearer test-token") throw new Error("token inesperado");
      const address = new URL(url);
      let payload;
      if (address.pathname === "/webmasters/v3/sites") {
        payload = { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] };
      } else if (address.pathname.endsWith("/sitemaps")) {
        payload = { sitemap: [{ path: "https://example.com/sitemap.xml", errors: "1", warnings: "0", isPending: false }] };
      } else if (address.pathname.includes("/sitemaps/")) {
        payload = { path: "https://example.com/sitemap.xml", errors: "1" };
      } else if (address.pathname.endsWith("/searchAnalytics/query")) {
        const body = JSON.parse(options.body);
        payload = { rows: body.dimensions[0] === "date" ? [
          { keys: ["2026-09-02"], clicks: 2, impressions: 8, ctr: 0.25, position: 3 },
          { keys: ["2026-09-01"], clicks: 1, impressions: 5, ctr: 0.2, position: 4 },
        ] : [{
          keys: body.dimensions.length === 2 ? ["consulta de prueba", "https://example.com/"] :
            [body.dimensions[0] === "query" ? "consulta de prueba" : "https://example.com/"],
          clicks: 1, impressions: 100, ctr: 0.01, position: 5,
        }] };
      } else if (address.pathname === "/v1/urlInspection/index:inspect") {
        payload = { inspectionResult: { indexStatusResult: { verdict: "PASS" } } };
      } else throw new Error("ruta inesperada");
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
  `;
  const client = new Client({ name: "gsc-test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(mock)}`, serverPath],
    env: { ...process.env, APPDATA: temporary, XDG_CONFIG_HOME: temporary, HOME: temporary },
  });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(Boolean(response.isError), false, response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  try {
    await client.connect(transport);
    const sites = await call("gsc_list_sites");
    assert.equal(sites.sites[0].siteUrl, "sc-domain:example.com");
    const performance = await call("gsc_search_performance", {
      siteUrl: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-02",
    });
    assert.deepEqual(performance.totals, { clicks: 3, impressions: 13 });
    assert.equal(performance.rows[0].value, "2026-09-01");
    const inspection = await call("gsc_inspect_url", {
      siteUrl: "sc-domain:example.com", url: "https://example.com/",
    });
    assert.equal(inspection.inspectionResult.indexStatusResult.verdict, "PASS");
    const advanced = await call("gsc_query_advanced", {
      siteUrl: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-02",
      dimensions: ["query", "page"], limit: 20,
      filters: [{ dimension: "query", operator: "contains", expression: "prueba" }],
    });
    assert.equal(advanced.rows.length, 1);
    assert.equal(advanced.nextStartRow, null);
    const sitemap = await call("gsc_sitemap_details", {
      siteUrl: "sc-domain:example.com", sitemapUrl: "https://example.com/sitemap.xml",
    });
    assert.equal(sitemap.sitemap.errors, "1");
    const audit = await call("seo_audit_site", {
      gscSiteUrl: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-02",
    });
    assert.equal(audit.status, "complete");
    assert(audit.findings.some((finding) => finding.code === "google_sitemap_errors"));
    const full = await call("seo_audit_advanced", {
      baseUrl: "https://audit.example/clean", gscSiteUrl: "sc-domain:example.com",
      startDate: "2026-09-01", endDate: "2026-09-02",
    });
    assert.equal(full.status, "complete");
    assert.deepEqual(full.official.google.performance.totals, { clicks: 3, impressions: 13 });
    assert(full.actions.some((action) => action.code === "query_page_opportunities"));
    assert.equal(full.trend.clicksChangePercent, 0);
  } finally {
    await client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("auditoría MCP por URL sin leer credenciales: evidencia, corrección y límites", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "seo-webmaster-url-"));
  const configPath = temporaryCredentialsPath(temporary);
  await mkdir(dirname(configPath), { recursive: true });
  // A credential read would fail even though the user only requested a crawl.
  await writeFile(configPath, "invalid credentials JSON");
  const mock = crawlMock + `globalThis.fetch = async (url) => {
    const page = mockCrawlFetch(url);
    if (!page) throw new Error("Petición a proveedor inesperada: " + url);
    return page;
  };`;
  const client = new Client({ name: "url-test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", `data:text/javascript,${encodeURIComponent(mock)}`, serverPath],
    env: { ...process.env, APPDATA: temporary, XDG_CONFIG_HOME: temporary, HOME: temporary },
  });
  const call = async (args) => {
    const response = await client.callTool({ name: "seo_audit_advanced", arguments: args });
    return { isError: Boolean(response.isError), value: JSON.parse(response.content[0].text) };
  };
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.find((tool) => tool.name === "seo_audit_advanced").inputSchema.required, ["baseUrl"]);

    const clean = await call({ baseUrl: "https://audit.example/clean" });
    assert.equal(clean.isError, false);
    assert.equal(clean.value.status, "complete");
    assert.deepEqual(clean.value.actions, []);
    assert.deepEqual(clean.value.errors, []);
    assert.equal(clean.value.official, null);
    assert.equal(clean.value.trend, null);
    assert.equal(clean.value.geo.importedReport, null);
    assert(clean.value.limitations.some((text) => text.includes("sin ejecutar JavaScript")));
    assert.equal(clean.value.summary.mode, "crawl_only");
    assert.equal(clean.value.summary.htmlPagesAnalyzed, 1);
    assert.equal(clean.value.summary.crawlTruncated, false);
    assert.match(clean.value.summary.message, /No se detectaron problemas.*Esto no significa/);
    assert(clean.value.summary.notChecked.some((text) => text.includes("validez semántica")));
    assert(clean.value.summary.checksPerformed.some((text) => text.includes("viewport") && text.includes("alt")));
    assert.equal(clean.value.crawl.pages[0].lang, "es");
    assert.deepEqual(clean.value.crawl.pages[0].images, { total: 0, missingAlt: 0, examples: [] });

    const canonical = await call({ baseUrl: "https://audit.example/invalid-canonical", maxPages: 1 });
    assert.equal(canonical.value.status, "complete");
    assert.equal(canonical.value.crawl.pages[0].status, 200);
    assert.equal(canonical.value.crawl.pages[0].title, "Página útil");
    assert.equal(canonical.value.actions.find((item) => item.code === "invalid_canonical").evidence.count, 1);
    assert(!canonical.value.actions.some((item) => ["http_error", "missing_canonical"].includes(item.code)));

    for (const path of ["robots-none", "robots-repeated"]) {
      const robots = await call({ baseUrl: `https://audit.example/${path}`, maxPages: 1 });
      assert(robots.value.actions.some((item) => item.code === "noindex"), path);
      assert.equal(robots.value.geo.readiness.indexablePages, 0);
    }
    const scoped = await call({ baseUrl: "https://audit.example/robots-scoped", maxPages: 1 });
    assert.deepEqual(scoped.value.actions, []);
    assert.equal(scoped.value.geo.readiness.indexablePages, 1);
    assert.equal(scoped.value.geo.readiness.snippetEligiblePages, 1);

    for (const path of ["nonhtml", "broken"]) {
      const page = await call({ baseUrl: `https://audit.example/${path}`, maxPages: 1 });
      assert(!page.value.actions.some((item) => ["missing_lang", "missing_viewport", "images_missing_alt"].includes(item.code)));
    }
    const many = await call({ baseUrl: "https://audit.example/many", maxPages: 25 });
    assert.equal(many.value.crawl.pageCount, 25);
    for (const code of ["missing_lang", "missing_viewport", "images_missing_alt"]) {
      const action = many.value.actions.find((item) => item.code === code);
      assert.equal(action.priority, "low");
      assert.equal(action.confidence, "inferred");
      assert.equal(action.affectedUrls.length, 20);
      assert.equal(action.evidence.count, 25);
      assert.equal(action.evidence.examples.length, 20);
      assert.deepEqual(action.impact, { metric: "affected_pages", value: 25 });
    }
    assert.equal(many.value.actions.find((item) => item.code === "images_missing_alt").evidence.imageCount, 25);

    const brokenJsonLd = await call({ baseUrl: "https://audit.example/jsonld-fixable", maxPages: 1 });
    const jsonLdAction = brokenJsonLd.value.actions.find((item) => item.code === "invalid_json_ld");
    assert.equal(jsonLdAction.confidence, "verified");
    assert.deepEqual(jsonLdAction.affectedUrls, ["https://audit.example/jsonld-fixable"]);
    assert.equal(jsonLdAction.evidence.count, 1);
    assert.equal(jsonLdAction.evidence.examples[0].blocks[0].scriptIndex, 1);
    assert.match(jsonLdAction.verification, /no confirma validez semántica/);
    assert.equal(brokenJsonLd.value.crawl.pages[0].jsonLdBlocks[0].status, "invalid_json");
    const repairedJsonLd = await call({ baseUrl: "https://audit.example/jsonld-fixable", maxPages: 1 });
    assert.equal(repairedJsonLd.value.crawl.pages[0].jsonLdBlocks[0].status, "parsed");
    assert(!repairedJsonLd.value.actions.some((item) => item.code === "invalid_json_ld"));

    const before = await call({ baseUrl: "https://audit.example/fixable", maxPages: 1 });
    const action = before.value.actions.find((item) => item.code === "missing_title");
    assert.equal(action.confidence, "verified");
    assert.deepEqual(action.affectedUrls, ["https://audit.example/fixable"]);
    assert.deepEqual(action.evidence, { count: 1 });
    assert(action.steps.length && action.verification);
    const after = await call({ baseUrl: "https://audit.example/fixable", maxPages: 1 });
    assert.deepEqual(after.value.actions, []);

    const review = await call({ baseUrl: "https://audit.example/review" });
    for (const code of ["noindex", "missing_canonical", "missing_description"]) {
      assert.equal(review.value.actions.find((item) => item.code === code).confidence, "inferred");
    }
    const offline = await call({ baseUrl: "https://audit.example/offline" });
    assert.equal(offline.value.status, "partial");
    assert.equal(offline.value.summary.htmlPagesAnalyzed, 0);
    assert.match(offline.value.summary.message, /informe es parcial/);
    assert.match(offline.value.crawl.pages[0].error, /Conexión interrumpida/);
    assert(offline.value.actions.some((item) => item.code === "http_error"));

    const site = await call({ baseUrl: "https://audit.example/" });
    assert.equal(site.value.status, "complete");
    assert.equal(site.value.crawl.pageCount, 3);
    assert.equal(site.value.crawl.skippedByRobots, 1);
    assert(site.value.actions.some((item) => item.code === "duplicate_titles" && item.evidence.count === 2));
    assert(site.value.actions.some((item) => item.code === "broken_internal_links" && item.affectedUrls.includes("https://audit.example/")));

    const limited = await call({ baseUrl: "https://audit.example/", maxPages: 1 });
    assert.equal(limited.value.crawl.pageCount, 1);
    assert.equal(limited.value.crawl.truncated, true);
    assert.equal(limited.value.summary.crawlTruncated, true);
    assert.equal(limited.value.summary.requestedMaxPages, 1);
    assert.match(limited.value.summary.message, /rastreo quedó limitado/);
    for (const baseUrl of ["http://127.0.0.1/", "https://private.example/"]) {
      const blocked = await call({ baseUrl });
      assert.equal(blocked.value.status, "unavailable");
      assert.equal(blocked.value.crawl, null);
      assert.equal(blocked.value.summary.htmlPagesAnalyzed, 0);
      assert.deepEqual(blocked.value.summary.checksPerformed, []);
      assert.match(blocked.value.summary.message, /No se pudo completar/);
      assert.equal(blocked.value.errors[0].source, "crawl");
      assert.match(blocked.value.errors[0].error, /públicas|no pública/);
    }
    const invalid = await call({ baseUrl: "https://audit.example/", maxPages: 501 });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("demo antes/después ejecuta el MCP sin red, claves ni nuevas herramientas", async () => {
  const client = new Client({ name: "demo-test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", new URL("../examples/offline-network.mjs", import.meta.url).href, serverPath],
  });
  const call = async (file) => {
    const response = await client.callTool({ name: "seo_audit_advanced", arguments: {
      baseUrl: `https://audit.example/${file}`, maxPages: 1,
    } });
    assert.equal(Boolean(response.isError), false, response.content[0].text);
    return JSON.parse(response.content[0].text);
  };
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 29);
    const before = await call("before.html");
    assert.equal(before.status, "complete");
    assert.equal(before.official, null);
    assert.equal(before.crawl.pages[0].status, 200);
    assert.deepEqual(before.actions.map((action) => action.code).sort(),
      ["images_missing_alt", "invalid_canonical", "missing_lang", "missing_viewport"]);
    const imageAction = before.actions.find((action) => action.code === "images_missing_alt");
    assert.equal(imageAction.evidence.imageCount, 1);
    assert.deepEqual(imageAction.evidence.examples[0].examples, [{ imageIndex: 1, src: "./audit-flow.svg" }]);
    assert(before.actions.every((action) => action.steps.length && action.verification && action.evidence.count === 1));
    const after = await call("after.html");
    assert.equal(after.status, "complete");
    assert.deepEqual(after.actions, []);
    assert.deepEqual(after.errors, []);
    assert.equal(after.crawl.pages[0].images.total, 2);
    assert.equal(after.crawl.pages[0].images.missingAlt, 0);
    assert.equal(after.crawl.pages[0].canonicalError, null);
    assert.match(after.summary.message, /Esto no significa/);
  } finally {
    await client.close();
  }
});
