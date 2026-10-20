import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { crawlSite } from "../dist/crawl.js";
import { seoAuditAdvanced } from "../dist/advanced.js";

const html = (url, links = []) => new Response(`<html lang="es"><head><title>${url.pathname}</title>` +
  `<meta name="description" content="Descripción"><meta name="viewport" content="width=device-width">` +
  `<link rel="canonical" href="${url.href}"></head><body><h1>Contenido</h1>` +
  links.map((link) => `<a href="${link}">Página</a>`).join("") + "</body></html>",
  { headers: { "content-type": "text/html" } });

async function network({ robots = "", sitemaps = {}, page = html,
  addresses = [{ address: "93.184.216.34", family: 4 }] }, run) {
  const originalFetch = globalThis.fetch;
  const originalLookup = dns.lookup;
  const requests = [];
  dns.lookup = async () => addresses;
  syncBuiltinESMExports();
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    requests.push(url.href);
    if (url.pathname === "/robots.txt") return typeof robots === "function" ? robots(url)
      : new Response(robots, { headers: { "content-type": "text/plain" } });
    if (sitemaps[url.pathname] !== undefined) return new Response(sitemaps[url.pathname]);
    if (["/sitemap.xml", "/sitemap-index.xml"].includes(url.pathname)) return new Response("<urlset/>");
    return page(url, options);
  };
  try { await run(requests); }
  finally {
    globalThis.fetch = originalFetch;
    dns.lookup = originalLookup;
    syncBuiltinESMExports();
  }
}

test("el rastreo respeta grupos robots compartidos, comodines, prioridad y su agente", async () => {
  const cases = [
    ["User-agent: *\nUser-agent: companion\nDisallow: /blocked", ["/blocked"], ["/"]],
    ["User-agent: *\nDisallow: /blocked*", ["/blocked-one"], ["/"]],
    ["User-agent: *\nDisallow: /private/\nAllow: /private/public\nDisallow: /*.pdf$",
      ["/private/a", "/private/public", "/file.pdf", "/file.pdf?x=1"], ["/", "/private/public", "/file.pdf?x=1"]],
    ["User-agent: *\nAllow: /\nUser-agent: SEO-Webmaster-MCP\nDisallow: /blocked", ["/blocked"], ["/"]],
    ["User-agent: *\nDisallow:", ["/allowed"], ["/", "/allowed"]],
  ];
  for (const [robots, links, expected] of cases) await network({ robots,
    page: (url) => html(url, url.pathname === "/" ? links : []),
  }, async (requests) => {
    const result = await crawlSite("https://audit.example/", 10);
    assert.deepEqual(result.pages.map((p) => p.url.replace("https://audit.example", "")), expected, robots);
    for (const link of links.filter((link) => !expected.includes(link))) {
      assert(!requests.includes("https://audit.example" + link), link);
    }
    assert.equal(result.truncated, false);
  });
});

test("robots no disponible detiene el origen y conserva un error explícito", async () => {
  for (const status of [429, 503]) await network({ robots: () => new Response("Unavailable", { status }) }, async (requests) => {
    const result = await crawlSite("https://audit.example/");
    assert.deepEqual(result.pages, []);
    assert.match(result.errors[0].error, new RegExp(String(status)));
    assert.deepEqual(requests, ["https://audit.example/robots.txt"]);
  });
  await network({ robots: () => { throw new Error("Conexión interrumpida"); } }, async (requests) => {
    const result = await crawlSite("https://audit.example/");
    assert.match(result.errors[0].error, /Conexión interrumpida/);
    assert.deepEqual(requests, ["https://audit.example/robots.txt"]);
  });
});

test("robots se comprueba también antes de seguir una redirección", async () => {
  await network({ robots: "User-agent: *\nDisallow: /blocked",
    page: () => new Response(null, { status: 302, headers: { location: "/blocked" } }),
  }, async (requests) => {
    const result = await crawlSite("https://audit.example/", 1);
    assert.equal(result.pages.length, 0);
    assert.equal(result.skippedByRobots, 1);
    assert(!requests.some((url) => url.endsWith("/blocked")));
  });
  await network({ robots: (url) => new Response(url.hostname.startsWith("www.") ? "User-agent: *\nDisallow: /" : ""),
    page: () => new Response(null, { status: 302, headers: { location: "https://www.audit.example/landing" } }),
  }, async (requests) => {
    const result = await crawlSite("https://audit.example/", 1);
    assert.equal(result.skippedByRobots, 1);
    assert(requests.includes("https://www.audit.example/robots.txt"));
    assert(!requests.includes("https://www.audit.example/landing"));
  });
});

test("redirecciones fuera del host, privadas y ciclos quedan acotados", async () => {
  for (const location of ["https://elsewhere.example/", "http://127.0.0.1/"]) await network({
    page: () => new Response(null, { status: 302, headers: { location } }),
  }, async (requests) => {
    const result = await crawlSite("https://audit.example/", 1);
    assert.equal(result.pages[0].status, 0);
    assert.match(result.pages[0].error, /públicas/);
    assert(!requests.includes(location));
  });
  await network({ page: () => new Response(null, { status: 302, headers: { location: "/" } }) }, async (requests) => {
    const result = await crawlSite("https://audit.example/", 1);
    assert.match(result.pages[0].error, /Demasiadas redirecciones/);
    assert.equal(requests.filter((url) => url === "https://audit.example/").length, 6);
  });
});

test("un sitemap con una URL inválida conserva las siguientes y normaliza fragmentos", async () => {
  await network({ sitemaps: { "/sitemap.xml": '<urlset><url><loc>https://[</loc></url>' +
    '<url><loc>https://audit.example/page#one</loc></url><url><loc>https://audit.example/page#two</loc></url>' +
    '<url><loc>ftp://audit.example/file</loc></url></urlset>' },
  }, async () => {
    const result = await crawlSite("https://audit.example/#top", 5);
    assert.deepEqual(result.pages.map((p) => p.url), ["https://audit.example/", "https://audit.example/page"]);
    assert(result.errors.some((e) => /URL mal formada/.test(e.error)));
    assert.equal(result.truncated, false);
  });
});

test("los duplicados no agotan el presupuesto ni producen un falso rastreo truncado", async () => {
  const page = (url) => html(url, { "/": ["/a", "/b"], "/a": ["/c", "/"], "/b": ["/c", "/"] }[url.pathname] || []);
  await network({ page }, async () => {
    const full = await crawlSite("https://audit.example/", 4);
    assert.equal(full.pages.length, 4);
    assert.equal(full.truncated, false);
    const partial = await crawlSite("https://audit.example/", 3);
    assert.equal(partial.pages.length, 3);
    assert.deepEqual(partial.truncationReasons, ["max_pages"]);
  });
  await network({ page: (url) => html(url, url.pathname === "/" ? Array.from({ length: 40 }, (_, i) => "/page" + i) : []) }, async () => {
    const result = await crawlSite("https://audit.example/", 2);
    assert.equal(result.pages.length, 2);
    assert(result.truncationReasons.includes("discovery_limit"));
  });
});

test("una URL que redirige a otra rastreada no inventa un título duplicado", async () => {
  let includeOther = false;
  await network({ page: (url) => url.pathname === "/a"
    ? new Response(null, { status: 301, headers: { location: "/b" } })
    : url.pathname === "/c" ? html(new URL("https://audit.example/b"))
      : html(url, url.pathname === "/" ? ["/a", "/b", ...(includeOther ? ["/c"] : [])] : []),
  }, async () => {
    const aliases = await seoAuditAdvanced({ baseUrl: "https://audit.example/", maxPages: 10 });
    assert(!aliases.actions.some((action) => action.code === "duplicate_titles"));
    includeOther = true;
    const distinct = await seoAuditAdvanced({ baseUrl: "https://audit.example/", maxPages: 10 });
    const duplicate = distinct.actions.find((action) => action.code === "duplicate_titles");
    assert.equal(duplicate.evidence.count, 2);
    assert.deepEqual(duplicate.affectedUrls.sort(), ["https://audit.example/b", "https://audit.example/c"]);
  });
});

test("el límite de sitemaps también se declara como cobertura incompleta", async () => {
  const sitemaps = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ["/index" + i + ".xml",
    `<sitemapindex><sitemap><loc>https://audit.example/index${i + 1}.xml</loc></sitemap></sitemapindex>`]));
  await network({ robots: "Sitemap: https://audit.example/index0.xml", sitemaps }, async () => {
    const result = await crawlSite("https://audit.example/");
    assert.equal(result.sitemapStatuses.length, 6);
    assert(result.truncationReasons.includes("sitemap_limit"));
  });
});

test("el límite se aplica a bytes mientras se descarga y cancela cuerpos excesivos", async () => {
  let cancelled = false;
  let chunks = 0;
  await network({ page: () => new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new TextEncoder().encode("ñ".repeat(150_000))); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/html" } }) }, async () => {
    const result = await crawlSite("https://audit.example/", 1);
    assert.equal(result.pages[0].status, 0);
    assert.match(result.pages[0].error, /demasiado grande/);
    assert(cancelled);
    assert(chunks < 10, "El cuerpo debe cancelarse antes de descargarlo entero");
  });
});

test("HTML y XHTML reconocen Content-Type sin depender de mayúsculas", async () => {
  for (const type of ["Text/HTML; Charset=UTF-8", "application/xhtml+xml"]) await network({
    page: () => new Response("<title>Contenido</title>", { headers: { "content-type": type } }),
  }, async () => {
    const result = await crawlSite("https://audit.example/", 1);
    assert.equal(result.pages[0].isHtml, true);
    assert.equal(result.pages[0].title, "Contenido");
  });
});

test("cabeceras HTTP repetidas mantienen separados el ámbito del agente y las reglas globales", async () => {
  const originalFetch = globalThis.fetch;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.setHeader("x-robots-tag", req.url === "/snippet" ? ["otherbot: noindex", "nosnippet"] : ["otherbot: nosnippet", "noindex"]);
    res.end("<title>Cabeceras repetidas</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await network({ page: (url, options) => originalFetch(`http://127.0.0.1:${server.address().port}${url.pathname}`, options) }, async () => {
      const globalIndex = await crawlSite("https://audit.example/", 1);
      assert.equal(globalIndex.pages[0].status, 200);
      assert.equal(globalIndex.pages[0].noindex, true);
      assert.equal(globalIndex.pages[0].snippetBlocked, false);
      const globalSnippet = await crawlSite("https://audit.example/snippet", 1);
      assert.equal(globalSnippet.pages[0].noindex, false);
      assert.equal(globalSnippet.pages[0].snippetBlocked, true);
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("DNS privado, mixto o IPv4 mapeado en IPv6 no llega a la capa HTTP", async () => {
  for (const addresses of [
    [{ address: "127.0.0.1", family: 4 }], [{ address: "::ffff:7f00:1", family: 6 }],
    [{ address: "::ffff:c0a8:1", family: 6 }], [{ address: "fe90::1", family: 6 }],
    [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }],
  ]) await network({ addresses }, async (requests) => {
    await assert.rejects(() => crawlSite("https://audit.example/"), /no pública/);
    assert.equal(requests.length, 0);
  });
});
