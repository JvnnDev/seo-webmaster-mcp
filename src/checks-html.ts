import type { CrawlPage } from "./crawl.js";
import { add, type Action, type CheckModule } from "./check-types.js";

function run(pages: CrawlPage[]): Action[] {
  const actions: Action[] = [];
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
      affectedUrls: affected,
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
    priority: "medium", confidence: "verified", affectedUrls: invalidCanonicals.map((p) => p.url),
    evidence: { count: invalidCanonicals.length, examples: invalidCanonicals.slice(0, 20).map((p) => ({
      url: p.url, selector: "link[rel='canonical']", error: p.canonicalError,
    })) }, effort: "low",
    steps: ["Corregir el href de link[rel='canonical'] para que resuelva a una URL HTTP(S) válida y comprobar que sea la versión elegida."],
    verification: "Al repetir la auditoría, canonical contiene la URL resuelta y canonicalError es null; esto no confirma qué canónica elegirá Google." });
  const missingAlt = pages.filter((p) => p.status === 200 && p.isHtml && p.images.missingAlt > 0);
  if (missingAlt.length) add(actions, { code: "images_missing_alt", title: "Imágenes sin atributo alt",
    priority: "low", confidence: "inferred", affectedUrls: missingAlt.map((p) => p.url),
    evidence: { count: missingAlt.length,
      imageCount: missingAlt.reduce((sum, p) => sum + p.images.missingAlt, 0),
      examples: missingAlt.slice(0, 20).map((p) => ({ url: p.url, ...p.images })),
    }, effort: "low",
    steps: ["Revisar las imágenes indicadas por su posición entre los img del body (desde 1) y su src observado.",
      "Añadir un alt descriptivo si la imagen informa; usar alt=\"\" si es decorativa. No generar descripciones sin revisar la imagen."],
    verification: "Al repetir la auditoría, las imágenes revisadas tienen atributo alt y baja images.missingAlt; comprobar manualmente la utilidad del texto alternativo." });

  return actions;
}

export const checks_html: CheckModule = {
  id: "checks-html", version: 1, scope: "page",
  run: ({ pages }) => run(pages),
};
