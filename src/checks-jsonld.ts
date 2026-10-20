import type { CrawlPage } from "./crawl.js";
import { add, type Action, type CheckModule } from "./check-types.js";

function run(pages: CrawlPage[]): Action[] {
  const actions: Action[] = [];
  const invalidJsonLd = pages.filter((page) => page.status === 200 && page.isHtml &&
    page.jsonLdBlocks.some((block) => block.status !== "parsed"));
  if (invalidJsonLd.length) add(actions, { code: "invalid_json_ld",
    title: "Bloques JSON-LD con JSON mal formado o raíz inválida", priority: "medium", confidence: "verified",
    affectedUrls: invalidJsonLd.map((page) => page.url),
    evidence: { count: invalidJsonLd.length, examples: invalidJsonLd.slice(0, 20).map((page) => ({
      url: page.url, blocks: page.jsonLdBlocks.filter((block) => block.status !== "parsed"),
    })) }, effort: "low",
    steps: ["Localizar el bloque application/ld+json indicado (numerado desde 1) y corregir su JSON o raíz.",
      "Verificar los requisitos del tipo de datos estructurados en Rich Results Test tras corregir la sintaxis."],
    verification: "Al repetir la auditoría, los bloques afectados tienen status parsed y desaparece esta acción; parsed no confirma validez semántica ni elegibilidad para resultados enriquecidos." });

  return actions;
}

export const checks_jsonld: CheckModule = {
  id: "checks-jsonld", version: 1, scope: "page",
  run: ({ pages }) => run(pages),
};
