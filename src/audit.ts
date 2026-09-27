import {
  bingBacklinkPages,
  bingCrawlIssues,
  bingCrawlStats,
  bingPerformance,
  bingSitemaps,
  bingTop,
  bingUrlInfo,
} from "./bing.js";
import {
  gscInspectUrl,
  gscOpportunities,
  gscPagePerformance,
  gscPerformance,
  gscSitemaps,
} from "./google.js";
import { dateRange, requiredString, type JsonObject } from "./utils.js";

type Finding = {
  severity: "high" | "medium" | "info";
  code: string;
  provider: "bing" | "google";
  message: string;
  nextStep?: string;
  evidence?: unknown;
};

type Job = { name: string; run: () => Promise<unknown> };

function record(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function numeric(value: unknown): number {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function rows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is JsonObject => Boolean(item)) : [];
}

function compactPerformance(value: JsonObject | undefined, field: "daily" | "rows") {
  if (!value) return null;
  const items = rows(value[field]);
  const dateKey = field === "daily" ? "date" : "value";
  return {
    status: value.status,
    totals: value.totals ?? null,
    days: items.length,
    firstDate: items[0]?.[dateKey] ?? items[0]?.value ?? null,
    lastDate: items.at(-1)?.[dateKey] ?? items.at(-1)?.value ?? null,
  };
}

export async function seoAuditSite(args: JsonObject) {
  const bingSiteUrl = args.bingSiteUrl === undefined ? undefined : requiredString(args, "bingSiteUrl");
  const gscSiteUrl = args.gscSiteUrl === undefined ? undefined : requiredString(args, "gscSiteUrl");
  if (!bingSiteUrl && !gscSiteUrl) {
    throw new Error("Indica bingSiteUrl, gscSiteUrl o ambos.");
  }
  const { startDate, endDate } = dateRange(args);
  const url = args.url === undefined ? undefined : requiredString(args, "url");

  const jobs: Job[] = [];
  if (bingSiteUrl) {
    const siteUrl = bingSiteUrl;
    jobs.push(
      { name: "bing.performance", run: () => bingPerformance({ siteUrl, startDate, endDate }) },
      { name: "bing.crawlIssues", run: () => bingCrawlIssues({ siteUrl, limit: 50 }) },
      { name: "bing.crawlStats", run: () => bingCrawlStats({ siteUrl }) },
      { name: "bing.sitemaps", run: () => bingSitemaps({ siteUrl }) },
      { name: "bing.topQueries", run: () => bingTop({ siteUrl, limit: 10 }, "query") },
      { name: "bing.topPages", run: () => bingTop({ siteUrl, limit: 10 }, "page") },
      { name: "bing.backlinks", run: () => bingBacklinkPages({ siteUrl, page: 0 }) },
    );
    if (url) jobs.push({ name: "bing.urlInfo", run: () => bingUrlInfo({ siteUrl, url }) });
  }
  if (gscSiteUrl) {
    const siteUrl = gscSiteUrl;
    jobs.push(
      { name: "google.performance", run: () => gscPerformance({ siteUrl, startDate, endDate, dimension: "date" }) },
      { name: "google.sitemaps", run: () => gscSitemaps({ siteUrl }) },
      { name: "google.topPages", run: () => gscPerformance({ siteUrl, startDate, endDate, dimension: "page", limit: 10 }) },
      { name: "google.opportunities", run: () => gscOpportunities({ siteUrl, startDate, endDate, limit: 10 }) },
    );
    if (url) jobs.push(
      { name: "google.urlInspection", run: () => gscInspectUrl({ siteUrl, url }) },
      { name: "google.pagePerformance", run: () => gscPagePerformance({ siteUrl, url, startDate, endDate }) },
    );
  }

  const data = new Map<string, unknown>();
  const errors: Array<{ source: string; error: string }> = [];
  for (let offset = 0; offset < jobs.length; offset += 3) {
    const batch = jobs.slice(offset, offset + 3);
    const settled = await Promise.allSettled(batch.map((job) => job.run()));
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") data.set(batch[index].name, result.value);
      else errors.push({
        source: batch[index].name,
        error: result.reason instanceof Error ? result.reason.message : "Error inesperado.",
      });
    });
  }
  const get = (name: string) => record(data.get(name));
  const findings: Finding[] = [];
  const bingPerformanceResult = get("bing.performance");
  const bingIssues = get("bing.crawlIssues");
  const bingSitemapsResult = get("bing.sitemaps");
  const bingBacklinks = get("bing.backlinks");
  const bingUrl = get("bing.urlInfo");
  const googlePerformanceResult = get("google.performance");
  const googleSitemapsResult = get("google.sitemaps");
  const googleOpportunities = get("google.opportunities");
  const googleInspection = get("google.urlInspection");

  if (bingPerformanceResult?.status === "no_data_from_bing") {
    findings.push({
      severity: "info", code: "bing_data_unavailable", provider: "bing",
      message: "Bing aún no devolvió datos de rendimiento; no se interpreta como cero tráfico.",
      nextStep: "Comprueba la propiedad en Bing Webmaster Tools y vuelve a consultar cuando termine el procesamiento.",
    });
  }
  if (numeric(bingIssues?.total) > 0) {
    findings.push({
      severity: "medium", code: "bing_crawl_issues", provider: "bing",
      message: "Bing reportó problemas de rastreo que conviene revisar.",
      nextStep: "Revisa las URLs y códigos HTTP del informe de problemas de rastreo de Bing.",
      evidence: { count: bingIssues?.total, examples: rows(bingIssues?.issues).slice(0, 3) },
    });
  }
  const bingFeeds = rows(bingSitemapsResult?.sitemaps);
  if (bingSitemapsResult && bingFeeds.length === 0) {
    findings.push({
      severity: "info", code: "bing_no_sitemaps", provider: "bing",
      message: "Bing no devolvió sitemaps registrados para esta propiedad.",
    });
  }
  for (const feed of bingFeeds) {
    if (typeof feed.Status === "string" && feed.Status.toLowerCase() !== "success") {
      findings.push({
        severity: "info", code: "bing_sitemap_status", provider: "bing",
        message: "Un sitemap de Bing no figura con estado Success.",
        evidence: { url: feed.Url, status: feed.Status },
      });
    }
  }

  if (googlePerformanceResult?.status === "no_data_in_range") {
    findings.push({
      severity: "info", code: "google_no_data_in_range", provider: "google",
      message: "Search Console no devolvió datos de rendimiento en el rango solicitado.",
    });
  }
  const googleSitemapRows = rows(googleSitemapsResult?.sitemaps);
  if (googleSitemapsResult && googleSitemapRows.length === 0) {
    findings.push({
      severity: "info", code: "google_no_sitemaps", provider: "google",
      message: "Search Console no devolvió sitemaps registrados para esta propiedad.",
    });
  }
  for (const sitemap of googleSitemapRows) {
    if (numeric(sitemap.errors) > 0) {
      findings.push({
        severity: "high", code: "google_sitemap_errors", provider: "google",
        message: "Un sitemap tiene errores de procesamiento en Search Console.",
        nextStep: "Abre el informe Sitemaps de Search Console, revisa el error concreto y corrige el archivo indicado.",
        evidence: { path: sitemap.path, errors: numeric(sitemap.errors) },
      });
    } else if (numeric(sitemap.warnings) > 0) {
      findings.push({
        severity: "medium", code: "google_sitemap_warnings", provider: "google",
        message: "Un sitemap tiene advertencias en Search Console.",
        evidence: { path: sitemap.path, warnings: numeric(sitemap.warnings) },
      });
    }
  }
  const index = record(record(googleInspection?.inspectionResult)?.indexStatusResult);
  if (index?.robotsTxtState === "DISALLOWED") {
    findings.push({
      severity: "high", code: "google_robots_disallowed", provider: "google",
      message: "Google indica que robots.txt bloquea la URL inspeccionada.", evidence: { url },
      nextStep: "Revisa la regla que afecta a esta URL en robots.txt y confirma si el bloqueo es intencional.",
    });
  }
  if (typeof index?.indexingState === "string" && index.indexingState.startsWith("BLOCKED_BY")) {
    findings.push({
      severity: "high", code: "google_indexing_blocked", provider: "google",
      message: "Google indica que la URL inspeccionada bloquea la indexación.",
      nextStep: "Comprueba las directivas noindex en la respuesta HTTP o en la página.",
      evidence: { url, indexingState: index.indexingState },
    });
  }
  if (index?.verdict === "FAIL") {
    findings.push({
      severity: "high", code: "google_url_inspection_failed", provider: "google",
      message: "La inspección de URL de Google devolvió un veredicto FAIL.",
      nextStep: "Abre la inspección de URL en Search Console y revisa el estado de cobertura.",
      evidence: { url, coverageState: index.coverageState },
    });
  }
  const bingInfo = record(bingUrl?.info);
  if (numeric(bingInfo?.HttpStatus) >= 400) {
    findings.push({
      severity: "medium", code: "bing_url_http_error", provider: "bing",
      message: "Bing registró una respuesta HTTP de error para la URL inspeccionada.",
      evidence: { url, httpStatus: bingInfo?.HttpStatus },
    });
  }
  findings.sort((a, b) => ({ high: 0, medium: 1, info: 2 })[a.severity] - ({ high: 0, medium: 1, info: 2 })[b.severity]);

  return {
    generatedAt: new Date().toISOString(),
    startDate,
    endDate,
    bingSiteUrl: bingSiteUrl ?? null,
    gscSiteUrl: gscSiteUrl ?? null,
    inspectedUrl: url ?? null,
    status: errors.length === 0 ? "complete" : data.size === 0 ? "unavailable" : "partial",
    findings,
    errors,
    bing: bingSiteUrl ? {
      performance: compactPerformance(bingPerformanceResult, "daily"),
      crawlIssues: bingIssues ? { total: bingIssues.total, examples: rows(bingIssues.issues).slice(0, 10) } : null,
      crawlStats: Array.isArray(get("bing.crawlStats")?.stats) ? (get("bing.crawlStats")?.stats as unknown[]).slice(-7) : get("bing.crawlStats")?.stats ?? null,
      sitemaps: bingFeeds,
      topQueries: rows(get("bing.topQueries")?.rows),
      topPages: rows(get("bing.topPages")?.rows),
      backlinks: bingBacklinks ? { totalPages: bingBacklinks.totalPages, firstPage: rows(bingBacklinks.links) } : null,
      urlInfo: bingUrl?.info ?? null,
    } : null,
    google: gscSiteUrl ? {
      performance: compactPerformance(googlePerformanceResult, "rows"),
      sitemaps: googleSitemapRows.map((item) => ({
        path: item.path, errors: numeric(item.errors), warnings: numeric(item.warnings), isPending: item.isPending,
      })),
      topPages: rows(get("google.topPages")?.rows),
      opportunities: rows(googleOpportunities?.candidates),
      urlInspection: index ?? null,
      pagePerformance: compactPerformance(get("google.pagePerformance"), "daily"),
    } : null,
    limitations: [
      "Robots.txt Tester y Site Scan de Bing solo están disponibles en el portal.",
      "La inspección de Google refleja la versión guardada en su índice, no una prueba en vivo.",
      "Las consultas de Search Console pueden omitir búsquedas anonimizadas.",
    ],
  };
}
