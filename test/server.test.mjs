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

test("contrato MCP, fechas y ausencia de datos de Bing", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "seo-webmaster-mcp-"));
  const configPath = join(temporary, "seo-webmaster-mcp", "credentials.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ bingApiKey: "test-key" }));

  const mock = `globalThis.fetch = async (url) => {
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
    env: { ...process.env, APPDATA: temporary, XDG_CONFIG_HOME: temporary },
  });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return { isError: Boolean(response.isError), value: JSON.parse(response.content[0].text) };
  };

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 25);
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
  } finally {
    await client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("consultas de Search Console con OAuth simulado", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "seo-webmaster-gsc-"));
  const configPath = join(temporary, "seo-webmaster-mcp", "credentials.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    google: { clientId: "client", clientSecret: "secret", refreshToken: "refresh" },
  }));

  const googleLibraryUrl = pathToFileURL(require.resolve("google-auth-library")).href;
  const mock = `
    import { OAuth2Client } from ${JSON.stringify(googleLibraryUrl)};
    OAuth2Client.prototype.getRequestHeaders = async () => new Headers({ authorization: "Bearer test-token" });
    globalThis.fetch = async (url, options) => {
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
          keys: [body.dimensions[0] === "query" ? "consulta de prueba" : "https://example.com/"],
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
    env: { ...process.env, APPDATA: temporary, XDG_CONFIG_HOME: temporary },
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
  } finally {
    await client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
