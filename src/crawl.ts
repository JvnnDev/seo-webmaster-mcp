import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { BlockList, isIP } from "node:net";
import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { Agent, type Dispatcher } from "undici";

// robots-parser is CommonJS; its default-export declaration needs an explicit
// require under TypeScript's NodeNext resolution.
const robotsParser = createRequire(import.meta.url)("robots-parser") as typeof import("robots-parser").default;

export type JsonLdBlock = {
  scriptIndex: number;
  status: "parsed" | "invalid_json" | "invalid_root";
  error?: string;
};

export type CrawlPage = {
  url: string;
  finalUrl: string;
  status: number;
  isHtml: boolean;
  redirects: number;
  title: string | null;
  description: string | null;
  canonical: string | null;
  canonicalError: string | null;
  lang: string | null;
  viewport: string | null;
  images: {
    total: number;
    missingAlt: number;
    examples: Array<{ imageIndex: number; src: string | null }>;
  };
  h1Count: number;
  noindex: boolean;
  snippetBlocked: boolean;
  textLength: number;
  author: boolean;
  structuredData: boolean;
  jsonLdBlocks: JsonLdBlock[];
  links: string[];
  error?: string;
};

const parser = new XMLParser({ ignoreAttributes: false });
const MAX_BODY = 2_000_000;
const CRAWLER = "SEO-Webmaster-MCP";
const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10],
  ["ff00::", 8], ["2001:db8::", 32],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv6");

function privateAddress(address: string): boolean {
  const family = isIP(address);
  return family === 0 || blockedAddresses.check(address, family === 6 ? "ipv6" : "ipv4");
}

function sameHost(candidate: string, hostname: string): boolean {
  return candidate === hostname || candidate === `www.${hostname}` || hostname === `www.${candidate}`;
}

async function safeUrl(input: string, hostname?: string) {
  const url = new URL(input);
  url.hash = "";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      (hostname && !sameHost(url.hostname, hostname)) || isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      url.hostname === "localhost" || /\.(?:localhost|local|internal)$/i.test(url.hostname)) {
    throw new Error("Solo se permiten URL HTTP(S) públicas del mismo host.");
  }
  let timer: NodeJS.Timeout | undefined;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Tiempo agotado al resolver el host.")), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some((item) => privateAddress(item.address))) {
    throw new Error("La URL apunta a una dirección no pública.");
  }
  return { url, addresses };
}

class RobotsBlockedError extends Error {}

async function getText(input: string, hostname: string, beforeRequest?: (url: URL) => Promise<void>): Promise<{ url: string; status: number; redirects: number; body: string; contentType: string; xRobots: string[] }> {
  let current = input;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const { url, addresses } = await safeUrl(current, hostname);
    await beforeRequest?.(url);
    // The socket must use the addresses we just checked, without resolving the
    // hostname a second time. Keep the original host for HTTP and TLS validation.
    const transport = new Agent({ connect: { lookup: (host, options, callback) => {
      const candidates = addresses.filter((item) => !options.family || item.family === Number(options.family));
      if (host !== url.hostname || !candidates.length) {
        callback(new Error("No hay una dirección pública validada para el host."), "");
      } else if (options.all) callback(null, candidates);
      else callback(null, candidates[0].address, candidates[0].family);
    } } });
    let robotsHeaders: string[] | undefined;
    // Fetch joins repeated headers, losing the boundary between a scoped header
    // and a subsequent global one. Observe the original pairs before that join;
    // forward every handler method with its original receiver intact.
    const dispatcher = transport.compose((dispatch) => (options, handler) => dispatch(options, new Proxy(handler, {
      get(target, name) {
        const method = Reflect.get(target, name);
        if (typeof method !== "function") return method;
        if (name === "onResponseStart") return (controller: unknown, status: number,
          headers: Record<string, string | string[] | undefined>, ...rest: unknown[]) => {
          if (status >= 200) {
            const value = headers["x-robots-tag"];
            robotsHeaders = Array.isArray(value) ? value : value ? [value] : [];
          }
          return method.call(target, controller, status, headers, ...rest);
        };
        if (name !== "onHeaders") return method.bind(target);
        return (status: number, headers: Array<string | Buffer>, ...rest: unknown[]) => {
          if (status >= 200) {
            robotsHeaders = [];
            for (let i = 0; i < headers.length; i += 2) {
              if (String(headers[i]).toLowerCase() === "x-robots-tag") robotsHeaders.push(String(headers[i + 1]));
            }
          }
          return method.call(target, status, headers, ...rest);
        };
      },
    })));
    try {
      const request: RequestInit & { dispatcher: Dispatcher } = {
        dispatcher, redirect: "manual", signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": `${CRAWLER}/1.0 (+https://github.com/JvnnDev/seo-webmaster-mcp)` },
      };
      const response = await fetch(url, request);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) return { url: url.href, status: response.status, redirects, body: "", contentType: "", xRobots: [] };
        current = new URL(location, url).href;
        continue;
      }
      const length = Number(response.headers.get("content-length") || 0);
      if (length > MAX_BODY) {
        await response.body?.cancel();
        throw new Error("Respuesta demasiado grande para la auditoría.");
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      if (reader) try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BODY) {
            await reader.cancel();
            throw new Error("Respuesta demasiado grande para la auditoría.");
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const body = Buffer.concat(chunks, bytes).toString("utf8");
      return { url: url.href, status: response.status, redirects, body,
        contentType: (response.headers.get("content-type") || "").toLowerCase(),
        xRobots: robotsHeaders ?? [response.headers.get("x-robots-tag") || ""] };
    } finally { await transport.destroy(); }
  }
  throw new Error("Demasiadas redirecciones.");
}

function items(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

export function sitemapLocations(xml: string): { pages: string[]; indexes: string[] } {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const index = parsed.sitemapindex as Record<string, unknown> | undefined;
  const set = parsed.urlset as Record<string, unknown> | undefined;
  return {
    indexes: items(index?.sitemap).map((x) => String(x.loc || "")).filter(Boolean),
    pages: items(set?.url).map((x) => String(x.loc || "")).filter(Boolean),
  };
}

// A scoped header applies until the next agent prefix. Parameterized directives
// (notably max-snippet) must not be mistaken for user-agent names.
function googleHeaderRules(header: string): string {
  let agent: string | null = null;
  const rules: string[] = [];
  const parameters = new Set(["max-snippet", "max-image-preview", "max-video-preview", "unavailable_after"]);
  for (const part of header.split(",")) {
    let rule = part.trim();
    const prefix = /^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i.exec(rule);
    if (prefix && !parameters.has(prefix[1].toLowerCase())) {
      agent = prefix[1].toLowerCase();
      rule = prefix[2];
    }
    if (agent === null || agent === "googlebot") rules.push(rule);
  }
  return rules.join(",");
}

export function analyzeHtml(url: string, finalUrl: string, status: number, redirects: number, html: string, isHtml = true, xRobots: string | string[] = ""): CrawlPage {
  const $ = cheerio.load(html);
  let documentBase = finalUrl;
  const baseHref = $("base[href]").first().attr("href");
  if (baseHref !== undefined) try { documentBase = new URL(baseHref, finalUrl).href; } catch { /* Use the document URL. */ }
  const canonicalHref = $("link[rel='canonical']").attr("href")?.trim();
  let canonical: string | null = null;
  let canonicalError: string | null = null;
  if (canonicalHref) {
    try {
      const target = new URL(canonicalHref, documentBase);
      if (!["http:", "https:"].includes(target.protocol)) throw new Error("Unsupported canonical protocol");
      canonical = target.href;
    } catch {
      canonicalError = "El href de link[rel='canonical'] no es una URL HTTP(S) válida.";
    }
  }
  const links = new Set<string>();
  $("a[href]").each((_, element) => {
    try {
      const target = new URL($(element).attr("href") || "", documentBase);
      if (target.hostname === new URL(finalUrl).hostname && ["http:", "https:"].includes(target.protocol)) {
        target.hash = "";
        links.add(target.href);
      }
    } catch { /* Ignore malformed links; they cannot be crawled. */ }
  });
  const main = $("main").first();
  const text = (main.length ? main : $("body")).text().replace(/\s+/g, " ").trim();
  const robots = (Array.isArray(xRobots) ? xRobots : [xRobots]).map(googleHeaderRules);
  $("meta[name]").each((_, element) => {
    const name = $(element).attr("name")?.trim().toLowerCase();
    if (name === "robots" || name === "googlebot") robots.push($(element).attr("content") || "");
  });
  // Keep parameter values attached: max-image-preview: none is not robots=none.
  const directives = robots.join(",").toLowerCase().replace(/\s*:\s*/g, ":").split(/[,\s]+/);
  const viewport = $("head meta[name]").toArray()
    .filter((element) => $(element).attr("name")?.trim().toLowerCase() === "viewport")
    .map((element) => $(element).attr("content")?.trim()).find(Boolean) || null;
  const images: CrawlPage["images"] = { total: 0, missingAlt: 0, examples: [] };
  $("body img").each((index, element) => {
    images.total++;
    if ($(element).attr("alt") !== undefined) return;
    images.missingAlt++;
    if (images.examples.length < 5) images.examples.push({
      imageIndex: index + 1, src: $(element).attr("src")?.trim().slice(0, 300) || null,
    });
  });
  const jsonLdBlocks: JsonLdBlock[] = [];
  $("script[type='application/ld+json']").each((index, element) => {
    const scriptIndex = index + 1;
    try {
      const value: unknown = JSON.parse($(element).text());
      const isObject = (item: unknown) => typeof item === "object" && item !== null && !Array.isArray(item);
      if (!isObject(value) && !(Array.isArray(value) && value.every(isObject))) {
        jsonLdBlocks.push({ scriptIndex, status: "invalid_root",
          error: "La raíz debe ser un objeto JSON o un array de objetos." });
      } else jsonLdBlocks.push({ scriptIndex, status: "parsed" });
    } catch (error) {
      // Do not echo source text from parser messages into reports.
      const position = error instanceof Error ? /position (\d+)/.exec(error.message)?.[1] : undefined;
      jsonLdBlocks.push({ scriptIndex, status: "invalid_json",
        error: position ? `JSON mal formado en la posición ${position}.` : "JSON mal formado o vacío." });
    }
  });
  return {
    url, finalUrl, status, isHtml, redirects,
    title: $("title").first().text().trim() || null,
    description: $("meta[name='description']").attr("content")?.trim() || null,
    canonical, canonicalError,
    lang: $("html").attr("lang")?.trim() || null,
    viewport, images,
    h1Count: $("h1").length,
    noindex: directives.includes("noindex") || directives.includes("none"),
    snippetBlocked: directives.includes("nosnippet") || directives.some((rule) => /^max-snippet:0+$/.test(rule)),
    textLength: text.length,
    author: Boolean($("meta[name='author']").attr("content") || $("[rel='author']").length || $("[itemprop='author']").length),
    structuredData: jsonLdBlocks.length > 0,
    jsonLdBlocks,
    links: [...links],
  };
}

export async function crawlSite(baseUrl: string, maxPages = 100) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) throw new Error("maxPages debe estar entre 1 y 500.");
  const { url: base } = await safeUrl(baseUrl);
  const errors: Array<{ url: string; error: string }> = [];
  type Rules = { parser: ReturnType<typeof robotsParser>; blocked: boolean };
  const rulesByOrigin = new Map<string, Rules>();
  const loadRules = async (origin: string): Promise<Rules> => {
    const cached = rulesByOrigin.get(origin);
    if (cached) return cached;
    let text = "";
    let blocked = false;
    const robotsUrl = `${origin}/robots.txt`;
    try {
      const response = await getText(robotsUrl, base.hostname);
      if (response.status >= 200 && response.status < 300) text = response.body;
      else if (response.status === 429 || response.status >= 500 || response.status < 400) {
        throw new Error(`robots.txt devolvió HTTP ${response.status}; no se rastrea este origen.`);
      }
    } catch (error) {
      blocked = true;
      errors.push({ url: robotsUrl, error: String(error) });
    }
    const rules = { parser: robotsParser(robotsUrl, text), blocked };
    rulesByOrigin.set(origin, rules);
    return rules;
  };
  const initialRules = await loadRules(base.origin);
  const checkRobots = async (url: URL) => {
    const rules = await loadRules(url.origin);
    if (rules.blocked || rules.parser.isAllowed(url.href, CRAWLER) === false) {
      throw new RobotsBlockedError("robots.txt excluye la URL solicitada.");
    }
  };
  const sitemapQueue = [...new Set([...initialRules.parser.getSitemaps(), `${base.origin}/sitemap.xml`, `${base.origin}/sitemap-index.xml`])];
  const sitemapSeen = new Set<string>();
  const sitemapStatuses: Array<{ url: string; status: number }> = [];
  const queue: string[] = [];
  const discovered = new Set<string>();
  let discoveryLimited = false;
  const enqueue = (input: string) => {
    const candidate = new URL(input);
    candidate.hash = "";
    if (!["http:", "https:"].includes(candidate.protocol) || candidate.username || candidate.password ||
        !sameHost(candidate.hostname, base.hostname) || discovered.has(candidate.href)) return;
    if (discovered.size >= maxPages * 2) { discoveryLimited = true; return; }
    discovered.add(candidate.href);
    queue.push(candidate.href);
  };
  enqueue(base.href);
  while (sitemapQueue.length && sitemapSeen.size < 6) {
    const current = sitemapQueue.shift()!;
    if (sitemapSeen.has(current)) continue;
    sitemapSeen.add(current);
    try {
      const { url: sitemapUrl } = await safeUrl(current, base.hostname);
      const rules = await loadRules(sitemapUrl.origin);
      if (rules.blocked || rules.parser.isAllowed(sitemapUrl.href, CRAWLER) === false) continue;
      const response = await getText(current, base.hostname, checkRobots);
      sitemapStatuses.push({ url: current, status: response.status });
      if (response.status !== 200 || !response.body.includes("<")) continue;
      const found = sitemapLocations(response.body);
      for (const next of found.indexes) if (!sitemapSeen.has(next)) sitemapQueue.push(next);
      for (const page of found.pages) {
        try { enqueue(page); }
        catch { if (errors.length < 20) errors.push({ url: current, error: "El sitemap contiene una URL mal formada; se conservan las demás entradas." }); }
      }
    } catch (error) {
      if (!(error instanceof RobotsBlockedError)) errors.push({ url: current, error: String(error) });
    }
  }
  const seen = new Set<string>();
  const pages: CrawlPage[] = [];
  let skippedByRobots = 0;
  while (queue.length && pages.length < maxPages) {
    const batch: string[] = [];
    while (queue.length && batch.length < Math.min(4, maxPages - pages.length)) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const rules = await loadRules(new URL(current).origin);
      if (rules.blocked || rules.parser.isAllowed(current, CRAWLER) === false) { skippedByRobots++; continue; }
      batch.push(current);
    }
    if (!batch.length) continue;
    const settled = await Promise.all(batch.map(async (url): Promise<CrawlPage | null> => {
      try {
        const result = await getText(url, base.hostname, checkRobots);
        const isHtml = /^(text\/html|application\/xhtml\+xml)(?:;|$)/.test(result.contentType);
        return analyzeHtml(url, result.url, result.status, result.redirects,
          isHtml ? result.body : "", isHtml, result.xRobots);
      } catch (error) {
        if (error instanceof RobotsBlockedError) { skippedByRobots++; return null; }
        return { url, finalUrl: url, status: 0, isHtml: false, redirects: 0, title: null, description: null,
          canonical: null, canonicalError: null, lang: null, viewport: null,
          images: { total: 0, missingAlt: 0, examples: [] },
          h1Count: 0, noindex: false, snippetBlocked: false, textLength: 0, author: false,
          structuredData: false, jsonLdBlocks: [], links: [], error: String(error) };
      }
    }));
    for (const page of settled) {
      if (!page) continue;
      pages.push(page);
      for (const link of page.links) enqueue(link);
    }
  }
  const pending = queue.some((url) => {
    const rules = rulesByOrigin.get(new URL(url).origin);
    return !rules || (!rules.blocked && rules.parser.isAllowed(url, CRAWLER) !== false);
  });
  const truncationReasons = [
    ...(pending ? ["max_pages"] : []),
    ...(discoveryLimited ? ["discovery_limit"] : []),
    ...(sitemapQueue.some((url) => !sitemapSeen.has(url)) ? ["sitemap_limit"] : []),
  ];
  return { baseUrl: base.href, pages, sitemapStatuses, skippedByRobots, errors,
    truncated: truncationReasons.length > 0, truncationReasons };
}
