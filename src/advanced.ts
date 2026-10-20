import { seoAuditSite } from "./audit.js";
import { crawlSite, type CrawlPage } from "./crawl.js";
import { geoReportSummary } from "./geo.js";
import { gscPerformance, gscQueryAdvanced } from "./google.js";
import { dateRange, requiredString, type JsonObject } from "./utils.js";

type Action = {
  code: string; priority: "high" | "medium" | "low"; confidence: "verified" | "inferred";
  title: string; affectedUrls: string[]; evidence: unknown; steps: string[];
  verification: string; effort: "low" | "medium" | "high";
  source: "google" | "bing" | "crawl" | "crosscheck" | "analysis";
  observedAt: string;
  impact: { metric: "affected_pages" | "impressions"; value: number } | null;
};

function defaultDates(args: JsonObject) {
  if (args.startDate !== undefined || args.endDate !== undefined) return dateRange(args);
  const end = new Date(Date.now() - 3 * 86_400_000);
  const start = new Date(end.getTime() - 89 * 86_400_000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function add(actions: Action[], action: Omit<Action, "source" | "observedAt" | "impact"> &
  Partial<Pick<Action, "source" | "impact">>) {
  const source = action.source || (action.code.startsWith("google_") ? "google" :
    action.code.startsWith("bing_") ? "bing" : action.code === "query_page_opportunities" ? "analysis" : "crawl");
  const evidence = action.evidence as { count?: number } | null;
  actions.push({ ...action, source, observedAt: new Date().toISOString(),
    impact: action.impact || (typeof evidence?.count === "number"
      ? { metric: "affected_pages", value: evidence.count } : null) });
}

function crawlActions(pages: CrawlPage[], actions: Action[]) {
  const checks: Array<{
    code: string; title: string; priority: Action["priority"]; effort: Action["effort"];
    predicate: (page: CrawlPage) => boolean; steps: string[]; verification: string;
  }> = [
    { code: "http_error", title: "Páginas con error HTTP o de conexión", priority: "high", effort: "medium",
      predicate: (p) => p.status === 0 || p.status >= 400,
      steps: ["Corregir la ruta o el servidor; si la página se retiró, actualizar enlaces y sitemap."],
      verification: "Las URL afectadas responden 200 o redirigen a una página vigente." },
    { code: "sitemap_redirect", title: "URL rastreadas que redirigen", priority: "medium", effort: "low",
      predicate: (p) => p.redirects > 0,
      steps: ["Comprobar si la redirección es intencional; actualizar los enlaces internos y sitemaps que usen la URL anterior cuando corresponda."],
      verification: "Los enlaces y sitemaps actualizados apuntan directamente al destino vigente." },
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
      predicate: (p) => p.status === 200 && p.isHtml && !p.canonical && !p.canonicalError,
      steps: ["Definir una URL canónica coherente cuando existan variantes de contenido."],
      verification: "Las variantes apuntan a la versión canónica elegida." },
    { code: "missing_h1", title: "Páginas sin encabezado principal", priority: "low", effort: "low",
      predicate: (p) => p.status === 200 && p.isHtml && p.h1Count === 0,
      steps: ["Añadir un encabezado principal que describa el contenido visible."],
      verification: "Cada página afectada presenta un H1 descriptivo." },
    { code: "missing_lang", title: "Páginas sin idioma declarado", priority: "low", effort: "low",
      predicate: (p) => p.status === 200 && p.isHtml && !p.lang,
      steps: ["Declarar el idioma real del contenido en html[lang], por ejemplo es o en, para ayudar a las tecnologías de asistencia."],
      verification: "El HTML recibido tiene un atributo lang no vacío; comprobar manualmente que corresponde al idioma del contenido." },
    { code: "missing_viewport", title: "Páginas sin meta viewport con contenido", priority: "low", effort: "low",
      predicate: (p) => p.status === 200 && p.isHtml && !p.viewport,
      steps: ["Revisar la configuración móvil y añadir meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" cuando corresponda."],
      verification: "El head contiene una meta viewport no vacía; comprobar el diseño en un navegador móvil, ya que este rastreo no lo renderiza." },
  ];
  for (const check of checks) {
    const affected = pages.filter(check.predicate).map((p) => p.url);
    if (affected.length) add(actions, { code: check.code, title: check.title,
      priority: check.priority,
      confidence: ["sitemap_redirect", "noindex", "snippet_blocked", "missing_description", "missing_canonical", "missing_h1", "missing_lang", "missing_viewport"].includes(check.code) ? "inferred" : "verified",
      affectedUrls: affected.slice(0, 20),
      evidence: { count: affected.length,
        ...(["missing_lang", "missing_viewport"].includes(check.code) ? { examples: affected.slice(0, 20).map((url) => ({
          url, selector: check.code === "missing_lang" ? "html[lang]" : "head meta[name='viewport']",
          observed: "Ausente o vacío en el HTML recibido.",
        })) } : {}),
      }, effort: check.effort,
      steps: check.steps, verification: check.verification });
  }
  const invalidCanonicals = pages.filter((p) => p.status === 200 && p.isHtml && p.canonicalError);
  if (invalidCanonicals.length) add(actions, { code: "invalid_canonical", title: "URL canónicas mal formadas",
    priority: "medium", confidence: "verified", affectedUrls: invalidCanonicals.map((p) => p.url).slice(0, 20),
    evidence: { count: invalidCanonicals.length, examples: invalidCanonicals.slice(0, 20).map((p) => ({
      url: p.url, selector: "link[rel='canonical']", error: p.canonicalError,
    })) }, effort: "low",
    steps: ["Corregir el href de link[rel='canonical'] para que resuelva a una URL HTTP(S) válida y comprobar que sea la versión elegida."],
    verification: "Al repetir la auditoría, canonical contiene la URL resuelta y canonicalError es null; esto no confirma qué canónica elegirá Google." });
  const missingAlt = pages.filter((p) => p.status === 200 && p.isHtml && p.images.missingAlt > 0);
  if (missingAlt.length) add(actions, { code: "images_missing_alt", title: "Imágenes sin atributo alt",
    priority: "low", confidence: "inferred", affectedUrls: missingAlt.map((p) => p.url).slice(0, 20),
    evidence: { count: missingAlt.length,
      imageCount: missingAlt.reduce((sum, p) => sum + p.images.missingAlt, 0),
      examples: missingAlt.slice(0, 20).map((p) => ({ url: p.url, ...p.images })),
    }, effort: "low",
    steps: ["Revisar las imágenes indicadas por su posición entre los img del body (desde 1) y su src observado.",
      "Añadir un alt descriptivo si la imagen informa; usar alt=\"\" si es decorativa. No generar descripciones sin revisar la imagen."],
    verification: "Al repetir la auditoría, las imágenes revisadas tienen atributo alt y baja images.missingAlt; comprobar manualmente la utilidad del texto alternativo." });
  const titleGroups = new Map<string, Set<string>>();
  for (const page of pages) if (page.status === 200 && page.isHtml && page.title) {
    const group = titleGroups.get(page.title) || new Set<string>();
    group.add(page.finalUrl);
    titleGroups.set(page.title, group);
  }
  const duplicate = [...titleGroups.values()].filter((group) => group.size > 1).flatMap((group) => [...group]);
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
  const invalidJsonLd = pages.filter((page) => page.status === 200 && page.isHtml &&
    page.jsonLdBlocks.some((block) => block.status !== "parsed"));
  if (invalidJsonLd.length) add(actions, { code: "invalid_json_ld",
    title: "Bloques JSON-LD con JSON mal formado o raíz inválida", priority: "medium", confidence: "verified",
    affectedUrls: invalidJsonLd.map((page) => page.url).slice(0, 20),
    evidence: { count: invalidJsonLd.length, examples: invalidJsonLd.slice(0, 20).map((page) => ({
      url: page.url, blocks: page.jsonLdBlocks.filter((block) => block.status !== "parsed"),
    })) }, effort: "low",
    steps: ["Localizar el bloque application/ld+json indicado (numerado desde 1) y corregir su JSON o raíz.",
      "Verificar los requisitos del tipo de datos estructurados en Rich Results Test tras corregir la sintaxis."],
    verification: "Al repetir la auditoría, los bloques afectados tienen status parsed y desaparece esta acción; parsed no confirma validez semántica ni elegibilidad para resultados enriquecidos." });
}

export async function seoAuditAdvanced(args: JsonObject) {
  const bingSiteUrl = args.bingSiteUrl === undefined ? undefined : requiredString(args, "bingSiteUrl");
  const gscSiteUrl = args.gscSiteUrl === undefined ? undefined : requiredString(args, "gscSiteUrl");
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
    bingSiteUrl || gscSiteUrl
      ? seoAuditSite({ bingSiteUrl, gscSiteUrl, startDate, endDate }) : Promise.resolve(null),
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
  if (official) errors.push(...official.errors);
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
        verification: "El proveedor deja de reportar el problema en una nueva consulta.",
        source: finding.provider });
    }
  }
  if (crawl) {
    crawlActions(crawl.pages, actions);
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
    generatedAt: new Date().toISOString(), startDate, endDate,
    summary: {
      mode: bingSiteUrl || gscSiteUrl ? "crawl_with_providers" : "crawl_only",
      message: message + (status === "partial" ? " Algunas comprobaciones fallaron; el informe es parcial." : "") +
        (crawl?.truncated ? " El rastreo quedó limitado; no se garantiza cobertura completa del sitio." : ""),
      requestedMaxPages: maxPages, crawledPages: crawl?.pages.length || 0, htmlPagesAnalyzed,
      crawlTruncated: Boolean(crawl?.truncated),
      truncationReasons: crawl?.truncationReasons || [],
      checksPerformed: [
        ...(crawl ? ["Respuestas HTTP, redirecciones y reglas de robots.txt para SEO-Webmaster-MCP en los orígenes procesados."] : []),
        ...(htmlPagesAnalyzed ? ["Títulos, meta descripciones, canónicas, H1 y directivas de indexación y snippets.",
          "Presencia de html[lang], meta viewport y atributos alt en las imágenes del body; hasta cinco ejemplos por página.",
          "Títulos repetidos y enlaces internos hacia URL fallidas dentro de la muestra rastreada.",
          "Presencia de señales de autor y JSON-LD; sintaxis JSON y raíz de cada bloque JSON-LD."] : []),
        ...(official ? ["Datos de proveedores disponibles en official; sus fallos se detallan en errors."] : []),
      ],
      notChecked: ["Renderizado JavaScript, rendimiento y Core Web Vitals.",
        "Indexación real de cada URL en Google o Bing y presencia en respuestas de IA.",
        "Identidad del autor, calidad del contenido y validez semántica o elegibilidad del marcado para resultados enriquecidos.",
        ...(!bingSiteUrl && !gscSiteUrl ? ["Datos de tráfico de Google Search Console y Bing Webmaster Tools."] : []),
      ],
    },
    trend,
    status,
    official, crawl: crawl ? { baseUrl: crawl.baseUrl, pageCount: crawl.pages.length,
      truncated: crawl.truncated, truncationReasons: crawl.truncationReasons, skippedByRobots: crawl.skippedByRobots,
      sitemapStatuses: crawl.sitemapStatuses, errors: crawl.errors,
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
      "La auditoría HTML analiza las respuestas recibidas sin ejecutar JavaScript; no confirma la indexación real en Google o Bing.",
      "lang, viewport y alt son comprobaciones de presencia en HTML: no validan el idioma real, el diseño móvil ni la calidad del texto alternativo o la accesibilidad completa. Un alt vacío es válido para una imagen decorativa.",
      "JSON-LD: se comprueban la sintaxis JSON y la raíz de los bloques recibidos; no se resuelven contextos remotos ni se valida schema.org o la elegibilidad para resultados enriquecidos.",
      ...(!bingSiteUrl && !gscSiteUrl ? ["Auditoría solo por URL: no se consultaron Google Search Console ni Bing Webmaster Tools."] : []),
      ...(gscSiteUrl ? ["Search Console puede omitir consultas anonimizadas y limitar filas.",
        "El informe GEO importado refleja solo funciones generativas de Google."] : []),
    ],
  };
}
