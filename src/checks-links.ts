import type { CrawlPage } from "./crawl.js";
import { add, type Action, type CheckModule, type CheckContext } from "./check-types.js";

export function internalLinkGraph(context: CheckContext) {
  const byAlias = new Map<string, string>();
  const nodes = new Map<string, { url: string; status: number; isHtml: boolean; inSitemap: boolean; sources: Set<string>; outgoing: number }>();
  for (const page of context.pages) {
    byAlias.set(page.url, page.finalUrl); byAlias.set(page.finalUrl, page.finalUrl);
    if (!nodes.has(page.finalUrl)) nodes.set(page.finalUrl, { url: page.finalUrl, status: page.status,
      isHtml: page.isHtml, inSitemap: context.sitemapUrls.includes(page.finalUrl) || context.sitemapUrls.includes(page.url), sources: new Set(), outgoing: 0 });
  }
  const processed = new Set<string>(), edges: Array<{ source: string; target: string; targetObserved: boolean }> = [];
  let truncated = false;
  for (const page of context.pages) {
    if (!page.isHtml || page.status !== 200 || processed.has(page.finalUrl)) continue;
    processed.add(page.finalUrl);
    const targets = new Set(page.links.map(target => byAlias.get(target) || target));
    nodes.get(page.finalUrl)!.outgoing = targets.size;
    for (const target of targets) {
      if (target !== page.finalUrl) nodes.get(target)?.sources.add(page.finalUrl);
      if (edges.length < 5000) edges.push({ source: page.finalUrl, target, targetObserved: nodes.has(target) });
      else truncated = true;
    }
  }
  return { nodes: [...nodes.values()].map(({ sources, ...node }) => ({ ...node, inboundFromSample: sources.size })), edges,
    truncated, edgeLimit: 5000,
    note: "Los enlaces entrantes se cuentan solo desde HTML 200 de la muestra. Cero enlaces observados no confirma que una página sea huérfana. Las aristas se limitan a 5000; los recuentos de nodos siguen considerando la muestra." };
}

function run(pages: CrawlPage[]): Action[] {
  const actions: Action[] = [];
  const titleGroups = new Map<string, Set<string>>();
  for (const page of pages) if (page.status === 200 && page.isHtml && page.title) {
    const group = titleGroups.get(page.title) || new Set<string>();
    group.add(page.finalUrl);
    titleGroups.set(page.title, group);
  }
  const duplicate = [...titleGroups.values()].filter((group) => group.size > 1).flatMap((group) => [...group]);
  if (duplicate.length) add(actions, { code: "duplicate_titles", title: "Títulos repetidos",
    priority: "medium", confidence: "verified", affectedUrls: duplicate,
    evidence: { count: duplicate.length }, effort: "medium",
    steps: ["Diferenciar el título según la intención y el contenido de cada URL."],
    verification: "Las páginas distintas tienen títulos descriptivos diferentes." });
  const alternateCanonicals = pages.filter((p) => p.status === 200 && p.canonical && p.canonical !== p.finalUrl);
  if (alternateCanonicals.length) add(actions, { code: "canonical_differs", title: "Canónicas diferentes de la URL final",
    priority: "medium", confidence: "inferred", affectedUrls: alternateCanonicals.map((p) => p.url),
    evidence: alternateCanonicals.slice(0, 20).map((p) => ({ url: p.url, finalUrl: p.finalUrl, canonical: p.canonical })),
    effort: "medium", steps: ["Comprobar si cada canónica alternativa es intencional y coherente con el sitemap y los enlaces internos."],
    verification: "Las páginas únicas se declaran canónicas a sí mismas y los duplicados apuntan a la versión elegida." });
  const failed = new Set(pages.filter((p) => p.status === 0 || p.status >= 400).map((p) => p.url));
  const brokenSources = pages.filter((p) => p.links.some((link) => failed.has(link))).map((p) => p.url);
  if (brokenSources.length) add(actions, { code: "broken_internal_links", title: "Enlaces internos hacia páginas fallidas",
    priority: "medium", confidence: "verified", affectedUrls: brokenSources,
    evidence: { count: brokenSources.length }, effort: "low",
    steps: ["Actualizar o retirar los enlaces internos a las URL con error."],
    verification: "Los enlaces afectados llevan a páginas disponibles." });

  return actions;
}

export const checks_links: CheckModule = {
  id: "checks-links", version: 1, scope: "site",
  run: ({ pages }) => run(pages),
  incomplete: ({ pages }) => pages.filter(page => page.links.some(link => !pages.some(target =>
    [target.url, target.finalUrl].includes(link) && target.status !== 0))).map(page => page.url),
};
