import type { CheerioAPI } from "cheerio";

export type HtmlDetails = {
  canonicalDeclarations: Array<{ href: string; resolved: string | null }>;
  hreflang: Array<{ language: string; href: string; resolved: string | null }>;
  headingLevels: number[];
  social: Record<string, string>;
  schema: { types: string[]; inspectedNodes: number; truncated: boolean;
    issues: Array<{ scriptIndex: number; type: string; property: string; reason: string }> };
};

function httpUrl(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    if (!value.trim() || !["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function htmlDetails($: CheerioAPI, base: string): HtmlDetails {
  const result: HtmlDetails = { canonicalDeclarations: [], hreflang: [], headingLevels: [], social: {},
    schema: { types: [], inspectedNodes: 0, truncated: false, issues: [] } };
  $("head link").each((_, element) => {
    const rel = ($(element).attr("rel") || "").toLowerCase().split(/\s+/);
    const href = $(element).attr("href") || "";
    if (rel.includes("canonical")) result.canonicalDeclarations.push({ href: href.slice(0, 2000), resolved: httpUrl(href, base) });
    if (rel.includes("alternate") && $(element).attr("hreflang") !== undefined) {
      result.hreflang.push({ language: ($(element).attr("hreflang") || "").trim(), href: href.slice(0, 2000), resolved: httpUrl(href, base) });
    }
  });
  $("body h1,body h2,body h3,body h4,body h5,body h6").each((_, element) => {
    result.headingLevels.push(Number(element.tagName.slice(1)));
  });
  $("head meta").each((_, element) => {
    const name = ($(element).attr("property") || $(element).attr("name") || "").trim().toLowerCase();
    if (/^(og:|twitter:)/.test(name) && !(name in result.social)) result.social[name] = ($(element).attr("content") || "").trim().slice(0, 2000);
  });
  $("script[type='application/ld+json']").each((script, element) => {
    let root: unknown;
    try { root = JSON.parse($(element).text()); } catch { return; }
    const queue: Array<{ value: unknown; schemaContext: boolean }> = [{ value: root, schemaContext: false }];
    // A bound protects against pathological JSON without loading remote contexts.
    let visited = 0;
    while (queue.length && visited < 2000) {
      const item = queue.pop()!;
      visited++;
      if (Array.isArray(item.value)) {
        for (const value of item.value) {
          if (queue.length + visited >= 2000) { result.schema.truncated = true; break; }
          queue.push({ value, schemaContext: item.schemaContext });
        }
        continue;
      }
      if (!item.value || typeof item.value !== "object") continue;
      const node = item.value as Record<string, unknown>;
      const context = node["@context"];
      const knownContext = (value: unknown): boolean => {
        const pending = [value];
        let budget = 64;
        while (pending.length && budget-- > 0) {
          const current = pending.pop();
          if (typeof current === "string" && /^https?:\/\/schema\.org\/?$/.test(current)) return true;
          if (Array.isArray(current)) {
            for (const child of current) {
              if (pending.length >= 64) { result.schema.truncated = true; break; }
              pending.push(child);
            }
          } else if (current && typeof current === "object") pending.push((current as Record<string, unknown>)["@vocab"]);
        }
        if (pending.length) result.schema.truncated = true;
        return false;
      };
      const schemaContext = context === undefined ? item.schemaContext : knownContext(context);
      const allTypes = (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]]) as unknown[];
      if (allTypes.length > 100) result.schema.truncated = true;
      const types = allTypes.slice(0, 100);
      const names = types.filter((type): type is string => typeof type === "string")
        .map(type => /^https?:\/\/schema\.org\//.test(type) ? type.replace(/^https?:\/\/schema\.org\//, "") : schemaContext ? type : "").filter(Boolean);
      if (names.length) {
        result.schema.inspectedNodes++;
        result.schema.types.push(...names);
        const missing = (key: string) => node[key] === undefined || node[key] === null || node[key] === "" || (Array.isArray(node[key]) && !node[key].length);
        const issue = (type: string, property: string, reason: string) => {
          if (result.schema.issues.length < 100) result.schema.issues.push({ scriptIndex: script + 1, type, property, reason });
          else result.schema.truncated = true;
        };
        for (const type of names) {
          if (type === "Product" && missing("name")) issue(type, "name", "Product no declara name.");
          if (type === "Product" && ["offers", "review", "aggregateRating"].every(missing)) issue(type, "offers|review|aggregateRating", "Product no declara ninguna de estas tres propiedades; revisar el objetivo del marcado.");
          if (["Article", "NewsArticle", "BlogPosting"].includes(type) && missing("headline")) issue(type, "headline", "Falta el titular recomendado; revisar su correspondencia con el artículo.");
          if (["Offer", "AggregateOffer"].includes(type)) {
            const key = type === "AggregateOffer" ? "lowPrice" : "price";
            // A priceSpecification is an alternative: do not report its price as missing.
            if (missing(key) && missing("priceSpecification")) issue(type, key, "La oferta no declara precio ni priceSpecification.");
            if (!missing(key) && missing("priceCurrency")) issue(type, "priceCurrency", "La oferta declara precio sin moneda.");
          }
          if (type === "Organization" && missing("name") && missing("@id")) issue(type, "name|@id", "Revisar cómo se identifica la organización: no declara name ni @id.");
          if (type === "BreadcrumbList" && Array.isArray(node.itemListElement)) {
            const positions = node.itemListElement.map(item => item && typeof item === "object" ? (item as Record<string, unknown>).position : undefined);
            if (positions.some(position => !Number.isInteger(position) || Number(position) < 1) || new Set(positions).size !== positions.length) issue(type, "itemListElement.position", "Las posiciones deben ser enteros positivos y no repetirse.");
          }
        }
      }
      for (const [key, value] of Object.entries(node)) if (key !== "@context" && value && typeof value === "object") {
        if (queue.length + visited >= 2000) { result.schema.truncated = true; break; }
        queue.push({ value, schemaContext });
      }
    }
    if (queue.length) result.schema.truncated = true;
  });
  result.schema.types = [...new Set(result.schema.types)];
  return result;
}
