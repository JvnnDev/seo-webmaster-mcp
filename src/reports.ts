import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { credentialsPath } from "./config.js";

const url = z.string().max(12000).refine(value => {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}, "URL HTTP(S) inválida");
const timestamp = z.string().datetime();
const priorities = z.enum(["high", "medium", "low"]);
const check = z.object({
  id: z.string().min(1).max(100), version: z.number().int().positive(), scope: z.enum(["page", "site"]),
  status: z.enum(["complete", "partial", "error", "not_applicable"]),
  evaluated: z.array(z.object({ url, finalUrl: url, status: z.number().int().min(0).max(599), isHtml: z.boolean() })).max(500),
  findings: z.array(z.object({ code: z.string().min(1).max(100), url, priority: priorities })).max(100000),
  coverageKey: z.string().regex(/^[a-f0-9]{64}$/),
  sampleKey: z.string().regex(/^[a-f0-9]{64}$/),
  unverifiedUrls: z.array(url).max(500),
  errors: z.array(z.object({ url, error: z.string().max(20000) })).max(500),
});
const action = z.object({ code: z.string().max(100), title: z.string().max(2000),
  priority: priorities, confidence: z.enum(["verified", "inferred"]),
  affectedUrls: z.array(url).max(500), steps: z.array(z.string().max(20000)).max(100),
  verification: z.string().max(20000),
}).passthrough();
export const reportSchema = z.object({
  schemaVersion: z.literal(1), engineVersion: z.literal("1"), generatedAt: timestamp, baseUrl: url,
  renderMode: z.enum(["static", "js"]).default("static"),
  status: z.enum(["complete", "partial", "unavailable"]),
  summary: z.object({ message: z.string(), htmlPagesAnalyzed: z.number().int().nonnegative(),
    crawlTruncated: z.boolean(), notChecked: z.array(z.string()), checksPerformed: z.array(z.string()) }).passthrough(),
  checks: z.array(check).max(100), actions: z.array(action).max(10000), errors: z.array(z.unknown()).max(10000),
}).passthrough();
export type AuditReport = z.infer<typeof reportSchema>;
const idPattern = /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const envelopeSchema = z.object({ format: z.literal("seo-webmaster-audit"), schemaVersion: z.literal(1),
  id: z.string().regex(idPattern), savedAt: timestamp, report: reportSchema });
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
export function reportsDirectory(): string { return join(dirname(credentialsPath()), "audits"); }

export function validateReport(value: unknown): AuditReport {
  const result = reportSchema.safeParse(value);
  if (!result.success) throw new Error("Informe inválido o incompatible. Usa un informe generado por esta versión (schemaVersion 1).");
  const ids = result.data.checks.map(check => check.id);
  if (new Set(ids).size !== ids.length) throw new Error("El informe contiene comprobaciones duplicadas.");
  return result.data;
}

export async function saveReport(value: unknown) {
  const report = validateReport(value);
  const id = `${Date.now()}-${randomUUID()}`;
  const envelope = { format: "seo-webmaster-audit", schemaVersion: 1, id, savedAt: new Date().toISOString(), report };
  const body = JSON.stringify(envelope, null, 2);
  if (Buffer.byteLength(body) > MAX_REPORT_BYTES) throw new Error("El informe supera el límite de 32 MB.");
  const directory = reportsDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `${id}.json`), body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { id, savedAt: envelope.savedAt, baseUrl: report.baseUrl, status: report.status };
}

export async function readReport(id: string) {
  if (!idPattern.test(id)) throw new Error("Identificador de auditoría inválido.");
  const path = join(reportsDirectory(), `${id}.json`);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT_BYTES) throw new Error("Archivo de auditoría inválido o demasiado grande.");
  const handle = await open(path, "r");
  try {
    // Bound the actual read as well as the initial stat, in case the file grows.
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_REPORT_BYTES) throw new Error("El informe supera el límite de 32 MB.");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("El archivo de auditoría no contiene JSON válido."); }
    const parsed = envelopeSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== id) throw new Error("Archivo de auditoría incompatible o identificador incorrecto.");
    validateReport(parsed.data.report);
    return parsed.data;
  } finally { await handle.close(); }
}

export async function listReports(limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit debe estar entre 1 y 100.");
  let names: string[];
  try { names = await readdir(reportsDirectory()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reports: [], errors: [], hasMore: false }; throw error; }
  const ids = names.filter(name => name.endsWith(".json") && idPattern.test(name.slice(0, -5))).sort().reverse();
  const reports = [], errors = [];
  for (const file of ids.slice(0, limit)) {
    const id = file.slice(0, -5);
    try {
      const saved = await readReport(id);
      reports.push({ id, savedAt: saved.savedAt, baseUrl: saved.report.baseUrl, status: saved.report.status,
        actions: saved.report.actions.length, htmlPagesAnalyzed: saved.report.summary.htmlPagesAnalyzed,
        renderMode: saved.report.renderMode, performanceMeasured: Boolean(saved.report.performance) });
    } catch (error) { errors.push({ id, error: error instanceof Error ? error.message : "Informe ilegible." }); }
  }
  return { reports, errors, hasMore: ids.length > limit };
}

type Occurrence = { module: string; code: string; url: string; priority: "high" | "medium" | "low" };
type Difference = Occurrence & { reason: string };
export function compareReports(before: unknown, after: unknown) {
  const baseline = validateReport(before), current = validateReport(after);
  if (new URL(baseline.baseUrl).origin !== new URL(current.baseUrl).origin) throw new Error("La comparación requiere auditorías del mismo origen HTTP(S).");
  if (baseline.generatedAt > current.generatedAt) throw new Error("La auditoría actual es anterior a la base.");
  const occurrences = (report: AuditReport) => new Map(report.checks.flatMap(check => check.findings.map(finding => {
    const item = { ...finding, module: check.id };
    return [JSON.stringify([item.module, item.code, item.url]), item] as const;
  })));
  const left = occurrences(baseline), right = occurrences(current);
  const comparable = (item: Occurrence, source: AuditReport, other: AuditReport): string | null => {
    if (source.renderMode !== other.renderMode) return "Cambió el modo de análisis entre HTML estático y DOM renderizado.";
    const oldCheck = source.checks.find(check => check.id === item.module);
    const check = other.checks.find(check => check.id === item.module);
    if (!oldCheck || !check || oldCheck.version !== check.version) return "La comprobación falta o cambió de versión.";
    if (!["complete", "partial"].includes(check.status)) return "La comprobación no se completó.";
    const page = check.evaluated.find(page => page.url === item.url || page.finalUrl === item.url);
    const previous = oldCheck.evaluated.find(page => page.url === item.url || page.finalUrl === item.url);
    if (!page || !previous || page.finalUrl !== previous.finalUrl) return "La URL no se volvió a comprobar con el mismo destino final.";
    if (check.errors.some(error => error.url === page.url) || oldCheck.errors.some(error => error.url === previous.url)) return "La comprobación falló para esta URL.";
    if (check.unverifiedUrls.includes(page.url) || oldCheck.unverifiedUrls.includes(previous.url)) return "Faltan destinos o datos necesarios para completar esta comprobación.";
    if (page.status === 0 || (item.code !== "http_error" && (!page.isHtml || page.status !== 200))) return "La página no tiene una respuesta comprobable para esta regla.";
    if (item.code !== "http_error" && (previous.status !== 200 || !previous.isHtml)) return "La página no era comprobable en la otra auditoría.";
    if (check.scope === "site") {
      // HTTP target repairs legitimately change statuses. Other site rules require identical coverage.
      const targetRule = ["broken_internal_links", "canonical_target_unavailable"].includes(item.code);
      if ((targetRule ? check.sampleKey !== oldCheck.sampleKey : check.coverageKey !== oldCheck.coverageKey)) return "Cambió la muestra de páginas necesaria para la comprobación del sitio.";
    }
    return null;
  };
  const added: Difference[] = [], persistent: Difference[] = [], resolved: Difference[] = [], notComparable: Difference[] = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const old = left.get(key), now = right.get(key), item = now || old!;
    const reason = comparable(item, now ? current : baseline, now ? baseline : current);
    if (reason) notComparable.push({ ...item, reason });
    else if (old && now) persistent.push({ ...item, reason: "La misma regla observa el hallazgo en ambas auditorías." });
    else if (now) added.push({ ...item, reason: "Hallazgo observado tras una comprobación equivalente sin ese hallazgo en la base." });
    else resolved.push({ ...item, reason: "La regla volvió a comprobar la URL y ya no observó el hallazgo." });
  }
  const incomplete = new Set<string>();
  for (const report of [baseline, current]) for (const check of report.checks) {
    const other = (report === baseline ? current : baseline).checks.find(candidate => candidate.id === check.id);
    if (!other || other.version !== check.version || !["complete", "not_applicable"].includes(check.status) || check.unverifiedUrls.length) incomplete.add(check.id);
  }
  const sample = (report: AuditReport) => [...new Set(report.checks.flatMap(check => check.evaluated.map(page =>
    JSON.stringify([page.url, page.finalUrl]))))].sort();
  const coverageChanged = JSON.stringify(sample(baseline)) !== JSON.stringify(sample(current));
  if (baseline.renderMode !== current.renderMode) incomplete.add("render-mode");
  return { schemaVersion: 1, baseUrl: current.baseUrl, baselineAt: baseline.generatedAt, currentAt: current.generatedAt,
    summary: { new: added.length, persistent: persistent.length, resolved: resolved.length, notComparable: notComparable.length,
      currentPartial: current.status !== "complete", baselinePartial: baseline.status !== "complete",
      noHtmlCoverage: current.summary.htmlPagesAnalyzed === 0 || baseline.summary.htmlPagesAnalyzed === 0,
      crawlTruncated: current.summary.crawlTruncated || baseline.summary.crawlTruncated, coverageChanged,
      incompleteChecks: [...incomplete].sort() },
    new: added, persistent, resolved, notComparable,
    limitations: ["Se comparan hallazgos del motor de rastreo por regla y URL; las métricas y acciones de proveedores no se consideran correcciones técnicas.",
      "Un hallazgo ausente solo se considera resuelto si hubo una comprobación equivalente. La comparación se limita a las muestras analizadas."] };
}

const md = (value: string) => value.replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!).replace(/[\\`*_[\]#|]/g, "\\$&").replace(/[\r\n]+/g, " ");
export function reportMarkdown(value: unknown): string {
  const report = validateReport(value);
  return ["# Auditoría SEO", "", `URL: ${md(report.baseUrl)}`, `Fecha: ${report.generatedAt}`,
    `Estado: ${report.status} · HTML analizado: ${report.summary.htmlPagesAnalyzed} · Rastreo limitado: ${report.summary.crawlTruncated ? "sí" : "no"}`,
    "", md(report.summary.message), "", "## Acciones", "",
    ...(report.actions.length ? report.actions.flatMap(action => [
      `### ${md(action.title)} (${action.priority}, ${action.confidence})`, "",
      ...action.affectedUrls.map(url => `- ${md(url)}`), "", ...action.steps.map(step => `- ${md(step)}`),
      "", `Verificación: ${md(action.verification)}`, "",
      "Evidencia:", "", "```json", JSON.stringify(action.evidence ?? null, null, 2).replace(/`/g, "\\u0060"), "```", "",
    ]) : ["No se observaron acciones en las comprobaciones y muestra analizadas.", ""]),
    `Modo de análisis: ${report.renderMode}`, "",
    ...(report.performance ? ["## Rendimiento (laboratorio y campo)", "", "```json",
      JSON.stringify(report.performance, null, 2).replace(/`/g, "\\u0060"), "```", ""] : []),
    "## Cobertura y pendientes", "", ...report.summary.checksPerformed.map(text => `- ${md(text)}`),
    ...report.summary.notChecked.map(text => `- Pendiente: ${md(text)}`), "", "## Errores", "",
    "```json", JSON.stringify(report.errors, null, 2).replace(/`/g, "\\u0060"), "```", ""].join("\n");
}

export function comparisonMarkdown(value: ReturnType<typeof compareReports>): string {
  return ["# Comparación de auditorías", "", `URL: ${md(value.baseUrl)}`,
    `Nuevos: ${value.summary.new} · Persistentes: ${value.summary.persistent} · Resueltos: ${value.summary.resolved} · No comparables: ${value.summary.notComparable}`, "",
    ...(value.summary.currentPartial || value.summary.baselinePartial || value.summary.noHtmlCoverage || value.summary.crawlTruncated || value.summary.coverageChanged || value.summary.incompleteChecks.length
      ? ["Comparación limitada: revisar la cobertura, los cambios de muestra y las comprobaciones incompletas de ambos informes.",
        `Módulos incompletos o incompatibles: ${value.summary.incompleteChecks.map(md).join(", ") || "ninguno"}.`, ""] : []),
    ...([ ["Nuevos", value.new], ["Persistentes", value.persistent], ["Resueltos", value.resolved], ["No comparables", value.notComparable] ] as const)
      .flatMap(([title, items]) => [`## ${title}`, "", ...items.map(item => `- ${md(item.code)} — ${md(item.url)}: ${md(item.reason)}`), ""]),
    ...value.limitations.map(text => `- ${md(text)}`), ""].join("\n");
}
