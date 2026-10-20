import { add, type Action, type CheckContext, type CheckModule } from "./check-types.js";

function finding(actions: Action[], code: string, title: string, url: string, evidence: unknown, steps: string[], verification: string,
  confidence: Action["confidence"] = "verified") {
  add(actions, { code, title, priority: "low", confidence, affectedUrls: [url],
    evidence: { count: 1, examples: [{ url, observed: evidence }] }, effort: "low", steps, verification });
}

export const checks_technical: CheckModule = {
  id: "checks-technical", version: 1, scope: "page",
  run: ({ pages }) => {
    const actions: Action[] = [];
    for (const page of pages.filter(p => p.isHtml && p.status === 200)) {
      const details = page.details;
      if (details.canonicalDeclarations.length > 1) finding(actions, "multiple_canonicals", "Múltiples declaraciones canonical", page.url,
        details.canonicalDeclarations, ["Conservar una única declaración canonical coherente en el head."],
        "El HTML contiene una sola declaración canonical válida.");
      const skips = details.headingLevels.flatMap((level, index, levels) => index > 0 && level > levels[index - 1] + 1
        ? [{ headingIndex: index + 1, previous: levels[index - 1], level }] : []);
      if (skips.length) finding(actions, "heading_level_skips", "Saltos en la jerarquía de encabezados", page.url, skips.slice(0, 20),
        ["Revisar si los niveles reflejan la estructura del contenido; no cambiarlos solo por su tamaño visual."],
        "Revisar la estructura de encabezados y repetir el análisis; no se considera error tener varios H1.", "inferred");
      const social = details.social;
      if (Object.keys(social).some(key => key.startsWith("og:"))) {
        const missing = ["og:title", "og:type", "og:image", "og:url"].filter(key => !social[key]);
        if (missing.length) finding(actions, "incomplete_open_graph", "Open Graph incompleto", page.url, { missing },
          ["Completar las propiedades básicas de Open Graph si se desea controlar la vista previa al compartir."],
          "El head declara og:title, og:type, og:image y og:url con contenido.", "inferred");
        const invalid = ["og:image", "og:url"].filter(key => social[key]).filter(key => {
          try { const target = new URL(social[key]); return !["http:", "https:"].includes(target.protocol) || Boolean(target.username || target.password); }
          catch { return true; }
        });
        if (invalid.length) finding(actions, "invalid_social_url", "URL de Open Graph no absolutas o inválidas", page.url, { properties: invalid },
          ["Usar URL HTTP(S) absolutas para og:image y og:url."], "Las propiedades indicadas contienen URL absolutas HTTP(S).");
      }
      if (social["twitter:card"] && !["summary", "summary_large_image", "app", "player"].includes(social["twitter:card"])) {
        finding(actions, "invalid_twitter_card", "Tipo de tarjeta social no reconocido", page.url, social["twitter:card"],
          ["Revisar twitter:card según el formato de tarjeta deseado."], "twitter:card declara un tipo admitido.", "inferred");
      }
    }
    return actions;
  },
};

const fetched = (context: CheckContext) => new Map(context.pages.flatMap(page => [[page.url, page], [page.finalUrl, page]]));
export const checks_hreflang: CheckModule = {
  id: "checks-hreflang", version: 1, scope: "site",
  incomplete: context => context.pages.filter(page => page.details.hreflang.some(link =>
    link.resolved && !context.pages.some(target => [target.url, target.finalUrl].includes(link.resolved!) && target.status === 200 && target.isHtml))).map(page => page.url),
  run: context => {
    const actions: Action[] = [], index = fetched(context);
    for (const page of context.pages.filter(p => p.isHtml && p.status === 200 && p.details.hreflang.length)) {
      const links = page.details.hreflang;
      const invalid = links.filter(link => {
        if (!link.resolved || !/^https?:\/\//i.test(link.href)) return true;
        if (link.language.toLowerCase() === "x-default") return false;
        try { return !/^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?$/i.test(link.language) || !Intl.getCanonicalLocales(link.language).length; }
        catch { return true; }
      });
      if (invalid.length) finding(actions, "invalid_hreflang", "Anotaciones hreflang con formato o URL inválidos", page.url, invalid.slice(0, 20),
        ["Usar etiquetas de idioma/región admitidas y URL HTTP(S) absolutas; revisar además los códigos aceptados por el buscador."],
        "Las anotaciones usan URL absolutas y etiquetas bien formadas; esta comprobación no valida todos los códigos admitidos por Google.");
      if (!links.some(link => link.resolved === page.finalUrl)) finding(actions, "hreflang_missing_self", "Hreflang sin referencia a la propia página", page.url, links.slice(0, 20),
        ["Añadir la versión propia al conjunto de alternates de esta página."], "Una anotación hreflang apunta a la URL final de esta página.");
      const nonReciprocal = links.filter(link => link.resolved && link.resolved !== page.finalUrl).filter(link => {
        const target = index.get(link.resolved!);
        return target?.status === 200 && target.isHtml && !target.details.hreflang.some(back => back.resolved === page.finalUrl);
      });
      if (nonReciprocal.length) finding(actions, "hreflang_missing_return", "Hreflang sin enlace de vuelta en páginas comprobadas", page.url,
        nonReciprocal.slice(0, 20), ["Completar las anotaciones recíprocas en ambas versiones."],
        "Las versiones comprobadas enlazan de vuelta a esta página mediante hreflang.");
    }
    return actions;
  },
};

export const checks_canonical_targets: CheckModule = {
  id: "checks-canonical-targets", version: 1, scope: "site",
  incomplete: context => context.pages.filter(page => page.canonical && !context.pages.some(target =>
    [target.url, target.finalUrl].includes(page.canonical!) && target.status !== 0)).map(page => page.url),
  run: context => {
    const actions: Action[] = [], index = fetched(context);
    for (const page of context.pages.filter(p => p.status === 200 && p.isHtml)) {
      const target = page.canonical ? index.get(page.canonical) : undefined;
      if (target && (target.status >= 400 || (target.status === 200 && target.isHtml && target.noindex))) finding(actions,
        "canonical_target_unavailable", "Canonical hacia un destino con error HTTP o noindex", page.url,
        { canonical: page.canonical, status: target.status, noindex: target.noindex },
        ["Revisar la canónica y usar un destino disponible que se desee indexar."],
        "La canónica comprobada devuelve HTML disponible y no declara noindex.", "inferred");
      if (context.sitemapUrls.includes(page.url) && (page.noindex || (page.canonical && page.canonical !== page.finalUrl))) finding(actions,
        "sitemap_indexability_conflict", "URL en sitemap con noindex o canónica alternativa", page.url,
        { noindex: page.noindex, canonical: page.canonical }, ["Revisar si la URL debe estar en el sitemap; incluir las versiones que se desea indexar."],
        "El sitemap y las señales de indexación observadas expresan la misma intención.", "inferred");
    }
    return actions;
  },
};

export const checks_schema: CheckModule = {
  id: "checks-schema-properties", version: 1, scope: "page",
  incomplete: context => context.pages.filter(page => page.details.schema.truncated).map(page => page.url),
  run: ({ pages }) => {
    const actions: Action[] = [];
    for (const page of pages.filter(p => p.status === 200 && p.isHtml && p.details.schema.issues.length)) finding(actions,
      "schema_properties_review", "Propiedades de datos estructurados que requieren revisión", page.url, page.details.schema.issues,
      ["Revisar las propiedades indicadas según el tipo de schema.org y el contenido real.",
        "Validar los requisitos actuales del buscador en Rich Results Test antes de publicar cambios."],
      "Las propiedades revisadas son coherentes; este conjunto limitado de reglas no garantiza elegibilidad para resultados enriquecidos.", "inferred");
    return actions;
  },
};
