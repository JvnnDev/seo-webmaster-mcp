import { add, type Action } from "./check-types.js";
import { runChecks } from "./checks.js";
import { seoAuditSite } from "./audit.js";
import { crawlSite } from "./crawl.js";
import { geoReportSummary } from "./geo.js";
import { gscPerformance, gscQueryAdvanced } from "./google.js";
import { dateRange, requiredString, type JsonObject } from "./utils.js";
import { pageSpeedReport } from "./performance.js";
import { internalLinkGraph } from "./checks-links.js";

function defaultDates(args: JsonObject) {
  if (args.startDate !== undefined || args.endDate !== undefined) return dateRange(args);
  const end = new Date(Date.now() - 3 * 86_400_000);
  const start = new Date(end.getTime() - 89 * 86_400_000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

export async function seoAuditAdvanced(args: JsonObject) {
  const bingSiteUrl = args.bingSiteUrl === undefined ? undefined : requiredString(args, "bingSiteUrl");
  const gscSiteUrl = args.gscSiteUrl === undefined ? undefined : requiredString(args, "gscSiteUrl");
  const baseUrl = requiredString(args, "baseUrl");
  const render = args.render ?? "static";
  if (render !== "static" && render !== "js") throw new Error("render debe ser static o js.");
  if (args.performance !== undefined && typeof args.performance !== "boolean") throw new Error("performance debe ser booleano.");
  const performanceStrategy = args.performanceStrategy ?? "mobile";
  if (performanceStrategy !== "mobile" && performanceStrategy !== "desktop") throw new Error("performanceStrategy debe ser mobile o desktop.");
  const { startDate, endDate } = defaultDates(args);
  const maxPages = args.maxPages === undefined ? render === "js" ? 10 : 100 : args.maxPages;
  if (typeof maxPages !== "number" || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) {
    throw new Error("maxPages debe ser un entero entre 1 y 500.");
  }
  if (render === "js" && maxPages > 20) throw new Error("render=js permite hasta 20 páginas por auditoría.");
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
  const priorEnd = new Date(Date.parse(`${startDate}T00:00:00Z`) - 86_400_000);
  const priorStart = new Date(priorEnd.getTime() - (days - 1) * 86_400_000);
  const priorDates = { startDate: priorStart.toISOString().slice(0, 10), endDate: priorEnd.toISOString().slice(0, 10) };
  const jobs = await Promise.allSettled([
    bingSiteUrl || gscSiteUrl
      ? seoAuditSite({ bingSiteUrl, gscSiteUrl, startDate, endDate }) : Promise.resolve(null),
    crawlSite(baseUrl, maxPages, { render }),
    gscSiteUrl ? geoReportSummary({ siteUrl: gscSiteUrl }) : Promise.resolve(null),
    gscSiteUrl ? gscQueryAdvanced({ siteUrl: gscSiteUrl, startDate, endDate,
      dimensions: ["query", "page"], limit: 1000 }) : Promise.resolve(null),
    gscSiteUrl ? gscPerformance({ siteUrl: gscSiteUrl, ...priorDates, dimension: "date" }) : Promise.resolve(null),
    args.performance ? pageSpeedReport(baseUrl, performanceStrategy) : Promise.resolve(null),
  ]);
  const values = jobs.map((item) => item.status === "fulfilled" ? item.value : null);
  const errors = jobs.flatMap((item, i) => item.status === "rejected"
    ? [{ source: ["official_audit", "crawl", "geo_import", "query_page", "prior_performance", "pagespeed"][i], error: String(item.reason) }] : []);
  const official = values[0] as Awaited<ReturnType<typeof seoAuditSite>> | null;
  if (official) errors.push(...official.errors);
  const crawl = values[1] as Awaited<ReturnType<typeof crawlSite>> | null;
  const geo = values[2];
  const queryPage = values[3] as Awaited<ReturnType<typeof gscQueryAdvanced>> | null;
  const prior = values[4] as Awaited<ReturnType<typeof gscPerformance>> | null;
  const performance = values[5] as Awaited<ReturnType<typeof pageSpeedReport>> | null;
  if (crawl) errors.push(...crawl.pages.filter(page => page.rendering && page.rendering.status !== "complete")
    .map(page => ({ source: "render", error: `${page.url}: ${page.rendering!.errors.map(error => error.error).join("; ")}` })));
  const actions: Action[] = [];
  if (official) {
    for (const finding of official.findings) {
      if (finding.severity === "info") continue;
      add(actions, { code: finding.code, title: finding.message,
        priority: finding.severity, confidence: "verified", affectedUrls: [],
        evidence: finding.evidence || { provider: finding.provider }, effort: "medium",
        steps: finding.nextStep ? [finding.nextStep] : ["Revisar el detalle en la herramienta de origen."],
        verification: "El proveedor deja de reportar el problema en una nueva consulta.",
        source: finding.provider });
    }
  }
  const checks = crawl ? runChecks({ pages: crawl.pages, sitemapUrls: crawl.sitemapUrls }) : { actions: [], results: [], errors: [] };
  actions.push(...checks.actions);
  errors.push(...checks.errors);
  if (crawl) {
    const submitted = new Set((official?.google?.sitemaps || []).map((row) => String(row.path)));
    const stale = crawl.sitemapStatuses.filter((row) => submitted.has(row.url) && row.status >= 400);
    if (stale.length) {
      add(actions, { code: "submitted_sitemap_http_error", title: "Sitemap enviado a Google que devuelve error HTTP",
        priority: "high", confidence: "verified", affectedUrls: stale.map((row) => row.url),
        evidence: stale, effort: "low", source: "crosscheck",
        impact: { metric: "affected_pages", value: stale.length },
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
    impact: { metric: "impressions", value: lowCtrPairs.reduce((sum, row) => sum + Number(row.impressions), 0) },
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
  const status = partial ? values.some(Boolean) ? "partial" : "unavailable" : "complete";
  const htmlPagesAnalyzed = crawl?.pages.filter((page) => page.isHtml && page.status === 200).length || 0;
  const message = status === "unavailable" ? "No se pudo completar ninguna fuente de la auditoría. Revisa los errores."
    : actions.length ? `Se ${actions.length === 1 ? "propone 1 acción" : `proponen ${actions.length} acciones`} según las comprobaciones realizadas; revisa la evidencia y el contexto de cada una.`
      : htmlPagesAnalyzed ? `No se detectaron problemas en las comprobaciones realizadas sobre ${htmlPagesAnalyzed} ${htmlPagesAnalyzed === 1 ? "página" : "páginas"} HTML. Esto no significa que no haya nada que mejorar.`
        : "No se detectaron acciones, pero no se analizaron páginas HTML con respuesta 200. Revisa la cobertura y los errores.";
  return {
    schemaVersion: 1 as const, engineVersion: "1", generatedAt: new Date().toISOString(), baseUrl, startDate, endDate,
    renderMode: render, performance,
    checks: checks.results,
    summary: {
      mode: bingSiteUrl || gscSiteUrl ? "crawl_with_providers" : "crawl_only",
      message: message + (status === "partial" ? " Algunas comprobaciones fallaron; el informe es parcial." : "") +
        (crawl?.truncated ? " El rastreo quedó limitado; no se garantiza cobertura completa del sitio." : ""),
      requestedMaxPages: maxPages, crawledPages: crawl?.pages.length || 0, htmlPagesAnalyzed,
      crawlTruncated: Boolean(crawl?.truncated),
      truncationReasons: crawl?.truncationReasons || [],
      rendering: { requested: render, complete: crawl?.pages.filter(page => page.rendering?.status === "complete").length || 0,
        partial: crawl?.pages.filter(page => page.rendering?.status === "partial").length || 0,
        unavailable: crawl?.pages.filter(page => page.rendering?.status === "unavailable").length || 0 },
      checksPerformed: [
        ...(crawl ? ["Respuestas HTTP, redirecciones y reglas de robots.txt para SEO-Webmaster-MCP en los orígenes procesados."] : []),
        ...(htmlPagesAnalyzed ? ["Títulos, meta descripciones, canónicas, H1 y directivas de indexación y snippets.",
          "Presencia de html[lang], meta viewport y atributos alt en las imágenes del body; hasta cinco ejemplos por página.",
          "Títulos repetidos y enlaces internos hacia URL fallidas dentro de la muestra rastreada.",
          "Presencia de señales de autor y JSON-LD; sintaxis JSON y raíz de cada bloque JSON-LD."] : []),
        ...(htmlPagesAnalyzed ? ["Declaraciones canonical múltiples, saltos de encabezados y metadatos sociales presentes.",
          "Hreflang declarado: formato, autorreferencia y reciprocidad con páginas disponibles en la muestra.",
          "Propiedades seleccionadas de Product, Offer, AggregateOffer, Article, Organization y BreadcrumbList en contextos schema.org reconocidos."] : []),
        ...(official ? ["Datos de proveedores disponibles en official; sus fallos se detallan en errors."] : []),
        ...(render === "js" && crawl?.pages.some(page => page.rendering) ? ["DOM renderizado cuando está disponible; consultar rendering en cada página y sus errores."] : []),
        ...(performance ? ["PageSpeed Insights para la URL de entrada: Lighthouse de laboratorio y datos de campo disponibles, separados por URL/origen."] : []),
      ],
      notChecked: [...(render === "static" ? ["Renderizado JavaScript."] : []),
        ...(!performance ? ["Rendimiento y Core Web Vitals no medidos en esta ejecución."] : []),
        "Indexación real de cada URL en Google o Bing y presencia en respuestas de IA.",
        "Identidad del autor, calidad del contenido y validez semántica o elegibilidad del marcado para resultados enriquecidos.",
        ...checks.results.filter(check => check.unverifiedUrls.length).map(check =>
          `${check.id}: faltan destinos o datos para completar la comprobación de ${check.unverifiedUrls.length} URL; consultar checks.unverifiedUrls.`),
        ...(!bingSiteUrl && !gscSiteUrl ? ["Datos de tráfico de Google Search Console y Bing Webmaster Tools."] : []),
      ],
    },
    trend,
    status,
    official, crawl: crawl ? { baseUrl: crawl.baseUrl, pageCount: crawl.pages.length,
      truncated: crawl.truncated, truncationReasons: crawl.truncationReasons, skippedByRobots: crawl.skippedByRobots,
      sitemapStatuses: crawl.sitemapStatuses, errors: crawl.errors,
      linkGraph: internalLinkGraph({ pages: crawl.pages, sitemapUrls: crawl.sitemapUrls }),
      pages: crawl.pages.map(({ links, ...page }) => ({ ...page, internalLinkCount: links.length })) } : null,
    geo: { importedReport: geo, readiness: crawl ? {
      examinedPages: crawl.pages.filter((p) => p.isHtml).length,
      indexablePages: crawl.pages.filter((p) => p.isHtml && p.status === 200 && !p.noindex).length,
      snippetEligiblePages: crawl.pages.filter((p) => p.isHtml && p.status === 200 && !p.noindex && !p.snippetBlocked).length,
      pagesWithSubstantialText: crawl.pages.filter((p) => p.isHtml && p.textLength >= 300).length,
      pagesWithAuthorSignal: crawl.pages.filter((p) => p.isHtml && p.author).length,
      pagesWithStructuredData: crawl.pages.filter((p) => p.isHtml && p.structuredData).length,
      note: "Señales descriptivas; no constituyen una puntuación ni garantizan presencia en respuestas de IA. indexablePages cuenta HTML con respuesta 200 sin noindex observado; snippetEligiblePages añade ausencia de bloqueo de snippets. Las directivas combinan reglas generales y específicas de Googlebot, no las dirigidas exclusivamente a otros agentes. No confirman indexación ni elegibilidad real. Las señales de autor y la presencia de JSON-LD no validan identidad ni semántica; jsonLdBlocks solo comprueba sintaxis JSON y raíz.",
    } : null },
    actions, errors,
    limitations: [
      render === "static" ? "La auditoría HTML analiza las respuestas recibidas sin ejecutar JavaScript; no confirma la indexación real en Google o Bing."
        : "El modo JS usa un navegador aislado y recursos de lectura limitados. No reproduce sesiones, interacción del usuario, imágenes ni todas las funciones del navegador; no confirma indexación.",
      "lang, viewport y alt son comprobaciones de presencia en HTML: no validan el idioma real, el diseño móvil ni la calidad del texto alternativo o la accesibilidad completa. Un alt vacío es válido para una imagen decorativa.",
      "JSON-LD: sintaxis, raíz y un conjunto limitado de propiedades en contextos schema.org reconocidos. No se resuelven contextos remotos ni referencias @id; no es una validación semántica completa ni garantiza elegibilidad para resultados enriquecidos.",
      ...(!bingSiteUrl && !gscSiteUrl ? ["Auditoría solo por URL: no se consultaron Google Search Console ni Bing Webmaster Tools."] : []),
      ...(gscSiteUrl ? ["Search Console puede omitir consultas anonimizadas y limitar filas.",
        "El informe GEO importado refleja solo funciones generativas de Google."] : []),
    ],
  };
}
