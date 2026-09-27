import { seoAuditSite } from "./audit.js";
import { crawlSite, type CrawlPage } from "./crawl.js";
import { geoReportSummary } from "./geo.js";
import { gscPerformance, gscQueryAdvanced } from "./google.js";
import { dateRange, requiredString, type JsonObject } from "./utils.js";

type Action = {
  code: string; priority: "high" | "medium" | "low"; confidence: "verified" | "inferred";
  title: string; affectedUrls: string[]; evidence: unknown; steps: string[];
  verification: string; effort: "low" | "medium" | "high";
};

function defaultDates(args: JsonObject) {
  if (args.startDate !== undefined || args.endDate !== undefined) return dateRange(args);
  const end = new Date(Date.now() - 3 * 86_400_000);
  const start = new Date(end.getTime() - 89 * 86_400_000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function add(actions: Action[], action: Action) { actions.push(action); }

function crawlActions(pages: CrawlPage[], actions: Action[]) {
  const checks: Array<{
    code: string; title: string; priority: Action["priority"]; effort: Action["effort"];
    predicate: (page: CrawlPage) => boolean; steps: string[]; verification: string;
  }> = [
    { code: "http_error", title: "Páginas con error HTTP o de conexión", priority: "high", effort: "medium",
      predicate: (p) => p.status === 0 || p.status >= 400,
      steps: ["Corregir la ruta o el servidor; si la página se retiró, actualizar enlaces y sitemap."],
      verification: "Las URL afectadas responden 200 o redirigen a una página vigente." },
    { code: "sitemap_redirect", title: "URL del sitemap que redirigen", priority: "medium", effort: "low",
      predicate: (p) => p.redirects > 0,
      steps: ["Sustituir en el sitemap la URL inicial por su destino canónico final."],
      verification: "Las URL declaradas en el sitemap responden directamente 200." },
    { code: "noindex", title: "Páginas rastreadas con noindex", priority: "high", effort: "low",
      predicate: (p) => p.noindex,
      steps: ["Decidir si la exclusión es intencional; si lo es, retirar la URL del sitemap; si no, quitar noindex."],
      verification: "El sitemap incluye solo páginas que se desean indexar." },
    { code: "snippet_blocked", title: "Páginas con fragmentos de búsqueda bloqueados", priority: "medium", effort: "low",
      predicate: (p) => p.snippetBlocked,
      steps: ["Confirmar si nosnippet o max-snippet:0 es intencional; permitir fragmentos si se busca visibilidad en resultados generativos de Google."],
      verification: "Las directivas robots de las páginas elegibles permiten fragmentos." },
    { code: "missing_title", title: "Páginas sin título HTML", priority: "medium", effort: "low",
      predicate: (p) => p.status === 200 && p.isHtml && !p.title,
      steps: ["Crear un título descriptivo y específico para cada página."],
      verification: "El HTML de cada URL contiene un título no vacío." },
    { code: "missing_description", title: "Páginas sin meta descripción", priority: "low", effort: "low",
      predicate: (p) => p.status === 200 && p.isHtml && !p.description,
      steps: ["Redactar una descripción útil para las páginas de mayor valor; Google puede mostrar otra."],
      verification: "Las páginas priorizadas tienen una descripción diferenciada." },
    { code: "missing_canonical", title: "Páginas sin URL canónica declarada", priority: "low", effort: "low",
      predicate: (p) => p.status === 200 && p.isHtml && !p.canonical,
      steps: ["Definir una URL canónica coherente cuando existan variantes de contenido."],
      verification: "Las variantes apuntan a la versión canónica elegida." },
    { code: "missing_h1", title: "Páginas sin encabezado principal", priority: "low", effort: "low",
      predicate: (p) => p.status === 200 && p.isHtml && p.h1Count === 0,
      steps: ["Añadir un encabezado principal que describa el contenido visible."],
      verification: "Cada página afectada presenta un H1 descriptivo." },
  ];
  for (const check of checks) {
    const affected = pages.filter(check.predicate).map((p) => p.url);
    if (affected.length) add(actions, { code: check.code, title: check.title,
      priority: check.priority, confidence: "verified", affectedUrls: affected.slice(0, 20),
      evidence: { count: affected.length }, effort: check.effort,
      steps: check.steps, verification: check.verification });
  }
  const titleGroups = new Map<string, string[]>();
  for (const page of pages) if (page.status === 200 && page.title) {
    titleGroups.set(page.title, [...(titleGroups.get(page.title) || []), page.url]);
  }
  const duplicate = [...titleGroups.values()].filter((group) => group.length > 1).flat();
  if (duplicate.length) add(actions, { code: "duplicate_titles", title: "Títulos repetidos",
    priority: "medium", confidence: "verified", affectedUrls: duplicate.slice(0, 20),
    evidence: { count: duplicate.length }, effort: "medium",
    steps: ["Diferenciar el título según la intención y el contenido de cada URL."],
    verification: "Las páginas distintas tienen títulos descriptivos diferentes." });
  const alternateCanonicals = pages.filter((p) => p.status === 200 && p.canonical && p.canonical !== p.finalUrl);
  if (alternateCanonicals.length) add(actions, { code: "canonical_differs", title: "Canónicas diferentes de la URL final",
    priority: "medium", confidence: "inferred", affectedUrls: alternateCanonicals.map((p) => p.url).slice(0, 20),
    evidence: alternateCanonicals.slice(0, 20).map((p) => ({ url: p.url, finalUrl: p.finalUrl, canonical: p.canonical })),
    effort: "medium", steps: ["Comprobar si cada canónica alternativa es intencional y coherente con el sitemap y los enlaces internos."],
    verification: "Las páginas únicas se declaran canónicas a sí mismas y los duplicados apuntan a la versión elegida." });
  const failed = new Set(pages.filter((p) => p.status === 0 || p.status >= 400).map((p) => p.url));
  const brokenSources = pages.filter((p) => p.links.some((link) => failed.has(link))).map((p) => p.url);
  if (brokenSources.length) add(actions, { code: "broken_internal_links", title: "Enlaces internos hacia páginas fallidas",
    priority: "medium", confidence: "verified", affectedUrls: brokenSources.slice(0, 20),
    evidence: { count: brokenSources.length }, effort: "low",
    steps: ["Actualizar o retirar los enlaces internos a las URL con error."],
    verification: "Los enlaces afectados llevan a páginas disponibles." });
}

export async function seoAuditAdvanced(args: JsonObject) {
  const bingSiteUrl = args.bingSiteUrl === undefined ? undefined : requiredString(args, "bingSiteUrl");
  const gscSiteUrl = args.gscSiteUrl === undefined ? undefined : requiredString(args, "gscSiteUrl");
  if (!bingSiteUrl && !gscSiteUrl) throw new Error("Indica bingSiteUrl, gscSiteUrl o ambos.");
  const baseUrl = requiredString(args, "baseUrl");
  const { startDate, endDate } = defaultDates(args);
  const maxPages = args.maxPages === undefined ? 100 : args.maxPages;
  if (typeof maxPages !== "number" || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) {
    throw new Error("maxPages debe ser un entero entre 1 y 500.");
  }
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
  const priorEnd = new Date(Date.parse(`${startDate}T00:00:00Z`) - 86_400_000);
  const priorStart = new Date(priorEnd.getTime() - (days - 1) * 86_400_000);
  const priorDates = { startDate: priorStart.toISOString().slice(0, 10), endDate: priorEnd.toISOString().slice(0, 10) };
  const jobs = await Promise.allSettled([
    seoAuditSite({ bingSiteUrl, gscSiteUrl, startDate, endDate }),
    crawlSite(baseUrl, maxPages),
    gscSiteUrl ? geoReportSummary({ siteUrl: gscSiteUrl }) : Promise.resolve(null),
    gscSiteUrl ? gscQueryAdvanced({ siteUrl: gscSiteUrl, startDate, endDate,
      dimensions: ["query", "page"], limit: 1000 }) : Promise.resolve(null),
    gscSiteUrl ? gscPerformance({ siteUrl: gscSiteUrl, ...priorDates, dimension: "date" }) : Promise.resolve(null),
  ]);
  const values = jobs.map((item) => item.status === "fulfilled" ? item.value : null);
  const errors = jobs.flatMap((item, i) => item.status === "rejected"
    ? [{ source: ["official_audit", "crawl", "geo_import", "query_page", "prior_performance"][i], error: String(item.reason) }] : []);
  const official = values[0] as Awaited<ReturnType<typeof seoAuditSite>> | null;
  const crawl = values[1] as Awaited<ReturnType<typeof crawlSite>> | null;
  const geo = values[2];
  const queryPage = values[3] as Awaited<ReturnType<typeof gscQueryAdvanced>> | null;
  const prior = values[4] as Awaited<ReturnType<typeof gscPerformance>> | null;
  const actions: Action[] = [];
  if (official) {
    for (const finding of official.findings) {
      if (finding.severity === "info") continue;
      add(actions, { code: finding.code, title: finding.message,
        priority: finding.severity, confidence: "verified", affectedUrls: [],
        evidence: finding.evidence || { provider: finding.provider }, effort: "medium",
        steps: finding.nextStep ? [finding.nextStep] : ["Revisar el detalle en la herramienta de origen."],
        verification: "El proveedor deja de reportar el problema en una nueva consulta." });
    }
  }
  if (crawl) {
    crawlActions(crawl.pages, actions);
    const submitted = new Set((official?.google?.sitemaps || []).map((row) => String(row.path)));
    const stale = crawl.sitemapStatuses.filter((row) => submitted.has(row.url) && row.status >= 400);
    if (stale.length) {
      add(actions, { code: "submitted_sitemap_http_error", title: "Sitemap enviado a Google que devuelve error HTTP",
        priority: "high", confidence: "verified", affectedUrls: stale.map((row) => row.url),
        evidence: stale, effort: "low",
        steps: ["Corregir el sitemap o retirar su envío antiguo de Search Console si fue reemplazado."],
        verification: "Solo quedan enviados sitemaps accesibles y vigentes." });
    }
  }
  const lowCtrPairs = (queryPage?.rows || []).filter((row) =>
    typeof row.impressions === "number" && row.impressions >= 100 &&
    typeof row.ctr === "number" && row.ctr < 0.02 &&
    typeof row.position === "number" && row.position <= 20).slice(0, 10);
  if (lowCtrPairs.length) add(actions, { code: "query_page_opportunities",
    title: "Pares consulta–página con visibilidad y pocos clics", priority: "medium", confidence: "inferred",
    affectedUrls: [...new Set(lowCtrPairs.map((row) => String(row.keys[1])))],
    evidence: lowCtrPairs, effort: "medium",
    steps: ["Revisar intención de búsqueda, título y descripción visibles para cada par; priorizar consultas relevantes para el negocio."],
    verification: "Comparar CTR, posición y clics durante un periodo equivalente tras el cambio." });
  const currentTotals = official?.google?.performance?.totals as { clicks?: number; impressions?: number } | null | undefined;
  const previousTotals = prior?.totals;
  const trend = currentTotals && previousTotals ? {
    current: currentTotals, previous: previousTotals,
    previousPeriod: priorDates,
    clicksChangePercent: previousTotals.clicks ? ((currentTotals.clicks || 0) - previousTotals.clicks) / previousTotals.clicks * 100 : null,
    impressionsChangePercent: previousTotals.impressions ? ((currentTotals.impressions || 0) - previousTotals.impressions) / previousTotals.impressions * 100 : null,
  } : null;
  const order = { high: 0, medium: 1, low: 2 };
  actions.sort((a, b) => order[a.priority] - order[b.priority] || a.code.localeCompare(b.code));
  const partial = errors.length > 0 || Boolean(crawl?.errors.length) || Boolean(crawl?.pages.some((page) => page.status === 0));
  return {
    generatedAt: new Date().toISOString(), startDate, endDate,
    trend,
    status: partial ? values.some(Boolean) ? "partial" : "unavailable" : "complete",
    official, crawl: crawl ? { baseUrl: crawl.baseUrl, pageCount: crawl.pages.length,
      truncated: crawl.truncated, skippedByRobots: crawl.skippedByRobots,
      sitemapStatuses: crawl.sitemapStatuses, errors: crawl.errors,
      pages: crawl.pages.map(({ links, ...page }) => ({ ...page, internalLinkCount: links.length })) } : null,
    geo: { importedReport: geo, readiness: crawl ? {
      examinedPages: crawl.pages.length,
      indexablePages: crawl.pages.filter((p) => p.status === 200 && !p.noindex).length,
      snippetEligiblePages: crawl.pages.filter((p) => p.status === 200 && !p.noindex && !p.snippetBlocked).length,
      pagesWithSubstantialText: crawl.pages.filter((p) => p.textLength >= 300).length,
      pagesWithAuthorSignal: crawl.pages.filter((p) => p.author).length,
      pagesWithStructuredData: crawl.pages.filter((p) => p.structuredData).length,
      note: "Señales descriptivas; no constituyen una puntuación ni garantizan presencia en respuestas de IA.",
    } : null },
    actions, errors,
    limitations: ["Search Console puede omitir consultas anonimizadas y limitar filas.",
      "La auditoría HTML analiza respuestas recibidas en esta ejecución; Google y Bing pueden tener otra versión indexada.",
      "El informe GEO importado refleja solo funciones generativas de Google."],
  };
}
