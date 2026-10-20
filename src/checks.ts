import { createHash } from "node:crypto";
import { object } from "./utils.js";
import type { Action, CheckContext, CheckModule } from "./check-types.js";
import { checks_html } from "./checks-html.js";
import { checks_links } from "./checks-links.js";
import { checks_jsonld } from "./checks-jsonld.js";
import { checks_technical, checks_hreflang, checks_canonical_targets, checks_schema } from "./checks-technical.js";

export type CheckResult = {
  id: string; version: number; scope: "page" | "site";
  status: "complete" | "partial" | "error" | "not_applicable";
  evaluated: Array<{ url: string; finalUrl: string; status: number; isHtml: boolean }>;
  findings: Array<{ code: string; url: string; priority: Action["priority"] }>;
  coverageKey: string;
  sampleKey: string;
  errors: Array<{ url: string; error: string }>;
  unverifiedUrls: string[];
};

export const CHECKS: readonly CheckModule[] = [checks_html, checks_links, checks_jsonld,
  checks_technical, checks_hreflang, checks_canonical_targets, checks_schema];

// All occurrences are retained in results; actions only carry bounded examples.
function mergeActions(actions: Action[]): Action[] {
  const groups = new Map<string, Action>();
  for (const action of actions) {
    if (!action.code || !Array.isArray(action.affectedUrls) || !action.affectedUrls.length ||
        !Array.isArray(action.steps) || !action.steps.length || !action.verification ||
        !["high", "medium", "low"].includes(action.priority) || !["verified", "inferred"].includes(action.confidence)) {
      throw new Error("Una comprobación produjo una acción inválida.");
    }
    const previous = groups.get(action.code);
    if (!previous) { groups.set(action.code, { ...action, affectedUrls: [...action.affectedUrls] }); continue; }
    previous.affectedUrls = [...new Set([...previous.affectedUrls, ...action.affectedUrls])];
    const left = object(previous.evidence), right = object(action.evidence);
    previous.evidence = { ...left,
      ...(typeof left.count === "number" && typeof right.count === "number" ? { count: left.count + right.count } : {}),
      ...(typeof left.imageCount === "number" && typeof right.imageCount === "number" ? { imageCount: left.imageCount + right.imageCount } : {}),
      ...(Array.isArray(left.examples) && Array.isArray(right.examples) ? { examples: [...left.examples, ...right.examples].slice(0, 20) } : {}),
    };
    if (previous.impact?.metric === "affected_pages" && action.impact?.metric === "affected_pages") {
      previous.impact = { metric: "affected_pages", value: previous.impact.value + action.impact.value };
    }
  }
  return [...groups.values()].map(action => ({ ...action, affectedUrls: action.affectedUrls.slice(0, 20) }));
}

export function runChecks(context: CheckContext, modules: readonly CheckModule[] = CHECKS) {
  const results: CheckResult[] = [], allActions: Action[] = [];
  for (const module of modules) {
    const result: CheckResult = { id: module.id, version: module.version, scope: module.scope,
      status: "complete", evaluated: [], findings: [], coverageKey: "", sampleKey: "", errors: [], unverifiedUrls: [] };
    const batches = module.scope === "site" ? [context.pages] : context.pages.map(page => [page]);
    if (!context.pages.length) result.status = "not_applicable";
    for (const pages of batches) {
      if (!pages.length) continue;
      try {
        const actions = module.run({ ...context, pages });
        // Validate/merge before accepting a module's output. Bad output is an error, not a pass.
        mergeActions(actions);
        const findings = actions.flatMap(action => action.affectedUrls.map(url => ({ code: action.code, url, priority: action.priority })));
        result.unverifiedUrls.push(...(module.incomplete?.({ ...context, pages }) || []));
        result.unverifiedUrls.push(...pages.filter(page => page.rendering && page.rendering.status !== "complete").map(page => page.url));
        result.evaluated.push(...pages.map(({ url, finalUrl, status, isHtml }) => ({ url, finalUrl, status, isHtml })));
        result.findings.push(...findings);
        allActions.push(...actions);
      } catch (error) {
        result.errors.push({ url: pages[0].url, error: error instanceof Error ? error.message : "Error inesperado." });
      }
    }
    if (result.errors.length) result.status = result.evaluated.length ? "partial" : "error";
    const coverage = context.pages.map(page => ({ url: page.url, finalUrl: page.finalUrl,
      status: page.status, isHtml: page.isHtml })).sort((a, b) => a.url.localeCompare(b.url));
    result.coverageKey = createHash("sha256").update(JSON.stringify({ pages: coverage, sitemaps: [...context.sitemapUrls].sort() })).digest("hex");
    result.sampleKey = createHash("sha256").update(JSON.stringify(coverage.map(({url, finalUrl}) => ({ url, finalUrl })))).digest("hex");
    results.push(result);
  }
  return { actions: mergeActions(allActions), results,
    errors: results.flatMap(result => result.errors.map(error => ({ source: result.id, ...error }))) };
}
