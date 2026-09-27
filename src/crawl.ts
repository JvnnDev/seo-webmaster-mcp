import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";

export type CrawlPage = {
  url: string;
  finalUrl: string;
  status: number;
  isHtml: boolean;
  redirects: number;
  title: string | null;
  description: string | null;
  canonical: string | null;
  h1Count: number;
  noindex: boolean;
  snippetBlocked: boolean;
  textLength: number;
  author: boolean;
  structuredData: boolean;
  links: string[];
  error?: string;
};

const parser = new XMLParser({ ignoreAttributes: false });
const MAX_BODY = 2_000_000;

function privateAddress(address: string): boolean {
  if (address.includes(":")) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") ||
      lower.startsWith("fe80") || lower.startsWith("::ffff:127.") || lower.startsWith("::ffff:10.") ||
      lower.startsWith("::ffff:192.168.") || lower.startsWith("::ffff:172.");
  }
  const octets = address.split(".").map(Number);
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 ||
    (octets[0] === 169 && octets[1] === 254) || (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
    (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) ||
    (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19));
}

async function safeUrl(input: string, hostname?: string): Promise<URL> {
  const url = new URL(input);
  const sameHost = !hostname || url.hostname === hostname ||
    url.hostname === `www.${hostname}` || hostname === `www.${url.hostname}`;
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      !sameHost || isIP(url.hostname) ||
      url.hostname === "localhost" || /\.(?:localhost|local|internal)$/i.test(url.hostname)) {
    throw new Error("Solo se permiten URL HTTP(S) públicas del mismo host.");
  }
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => privateAddress(item.address))) {
    throw new Error("La URL apunta a una dirección no pública.");
  }
  return url;
}

async function getText(input: string, hostname: string): Promise<{ url: string; status: number; redirects: number; body: string; contentType: string; xRobots: string }> {
  let current = input;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const url = await safeUrl(current, hostname);
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "SEO-Webmaster-MCP/1.0 (+https://github.com/JvnnDev/seo-webmaster-mcp)" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { url: url.href, status: response.status, redirects, body: "", contentType: "", xRobots: "" };
      current = new URL(location, url).href;
      continue;
    }
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_BODY) throw new Error("Respuesta demasiado grande para la auditoría.");
    const body = await response.text();
    if (body.length > MAX_BODY) throw new Error("Respuesta demasiado grande para la auditoría.");
    return { url: url.href, status: response.status, redirects, body,
      contentType: response.headers.get("content-type") || "",
      xRobots: response.headers.get("x-robots-tag") || "" };
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

export function analyzeHtml(url: string, finalUrl: string, status: number, redirects: number, html: string, isHtml = true, xRobots = ""): CrawlPage {
  const $ = cheerio.load(html);
  const canonical = $("link[rel='canonical']").attr("href");
  const links = new Set<string>();
  $("a[href]").each((_, element) => {
    try {
      const target = new URL($(element).attr("href") || "", finalUrl);
      if (target.hostname === new URL(finalUrl).hostname && ["http:", "https:"].includes(target.protocol)) {
        target.hash = "";
        links.add(target.href);
      }
    } catch { /* Ignore malformed links; they cannot be crawled. */ }
  });
  const main = $("main").first();
  const text = (main.length ? main : $("body")).text().replace(/\s+/g, " ").trim();
  const robots = [$("meta[name='robots']").attr("content"), $("meta[name='googlebot']").attr("content"), xRobots].join(",");
  return {
    url, finalUrl, status, isHtml, redirects,
    title: $("title").first().text().trim() || null,
    description: $("meta[name='description']").attr("content")?.trim() || null,
    canonical: canonical ? new URL(canonical, finalUrl).href : null,
    h1Count: $("h1").length,
    noindex: /(?:^|[,\s])noindex(?:[,\s]|$)/i.test(robots),
    snippetBlocked: /(?:^|[,\s])nosnippet(?:[,\s]|$)|max-snippet\s*:\s*0/i.test(robots),
    textLength: text.length,
    author: Boolean($("meta[name='author']").attr("content") || $("[rel='author']").length || $("[itemprop='author']").length),
    structuredData: $("script[type='application/ld+json']").length > 0,
    links: [...links],
  };
}

function disallowed(path: string, robots: string): boolean {
  let general = false;
  const rules: Array<{ path: string; allowed: boolean }> = [];
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    const match = /^(user-agent|disallow|allow)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    if (match[1].toLowerCase() === "user-agent") general = match[2].trim() === "*";
    else if (general && match[2].trim()) rules.push({ path: match[2].trim(),
      allowed: match[1].toLowerCase() === "allow" });
  }
  const applicable = rules.filter((rule) => path.startsWith(rule.path))
    .sort((a, b) => b.path.length - a.path.length || Number(b.allowed) - Number(a.allowed));
  return applicable.length > 0 && !applicable[0].allowed;
}

export async function crawlSite(baseUrl: string, maxPages = 100) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) throw new Error("maxPages debe estar entre 1 y 500.");
  const base = await safeUrl(baseUrl);
  const origin = base.origin;
  let robots = "";
  const errors: Array<{ url: string; error: string }> = [];
  try {
    const response = await getText(`${origin}/robots.txt`, base.hostname);
    if (response.status === 200) robots = response.body;
  } catch (error) {
    errors.push({ url: `${origin}/robots.txt`, error: String(error) });
  }
  const declared = [...robots.matchAll(/^Sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  const sitemapQueue = [...new Set([...declared, `${origin}/sitemap.xml`, `${origin}/sitemap-index.xml`])];
  const sitemapSeen = new Set<string>();
  const sitemapStatuses: Array<{ url: string; status: number }> = [];
  const urls = new Set<string>([base.href]);
  while (sitemapQueue.length && sitemapSeen.size < 6) {
    const current = sitemapQueue.shift()!;
    if (sitemapSeen.has(current)) continue;
    sitemapSeen.add(current);
    try {
      const response = await getText(current, base.hostname);
      sitemapStatuses.push({ url: current, status: response.status });
      if (response.status !== 200 || !response.body.includes("<")) continue;
      const found = sitemapLocations(response.body);
      for (const next of found.indexes) if (!sitemapSeen.has(next)) sitemapQueue.push(next);
      for (const page of found.pages) {
        const candidate = new URL(page);
        if (candidate.hostname === base.hostname || candidate.hostname === `www.${base.hostname}` || base.hostname === `www.${candidate.hostname}`) urls.add(candidate.href);
      }
    } catch (error) {
      errors.push({ url: current, error: String(error) });
    }
  }
  const queue = [...urls];
  const seen = new Set<string>();
  const pages: CrawlPage[] = [];
  let skippedByRobots = 0;
  while (queue.length && pages.length < maxPages) {
    const batch: string[] = [];
    while (queue.length && batch.length < Math.min(4, maxPages - pages.length)) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (disallowed(new URL(current).pathname, robots)) { skippedByRobots++; continue; }
      batch.push(current);
    }
    if (!batch.length) continue;
    const settled = await Promise.all(batch.map(async (url): Promise<CrawlPage> => {
      try {
        const result = await getText(url, base.hostname);
        const isHtml = result.contentType.includes("text/html");
        return analyzeHtml(url, result.url, result.status, result.redirects,
          isHtml ? result.body : "", isHtml, result.xRobots);
      } catch (error) {
        return { url, finalUrl: url, status: 0, isHtml: false, redirects: 0, title: null, description: null,
        canonical: null, h1Count: 0, noindex: false, snippetBlocked: false, textLength: 0, author: false,
          structuredData: false, links: [], error: String(error) };
      }
    }));
    for (const page of settled) {
      pages.push(page);
      for (const link of page.links) if (!seen.has(link) && queue.length + pages.length < maxPages * 2) queue.push(link);
    }
  }
  return { baseUrl: base.href, pages, sitemapStatuses, skippedByRobots, errors,
    truncated: queue.length > 0 || urls.size > maxPages };
}
