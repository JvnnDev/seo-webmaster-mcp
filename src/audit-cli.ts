import { open, writeFile } from "node:fs/promises";
import { seoAuditAdvanced } from "./advanced.js";
import { compareReports, comparisonMarkdown, listReports, readReport, reportMarkdown, saveReport, validateReport } from "./reports.js";

function parse(args: string[], values: string[], flags: string[]) {
  const positional: string[] = [], options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    if (options[value] !== undefined) throw new Error(`Opción repetida: ${value}`);
    if (flags.includes(value)) options[value] = true;
    else if (values.includes(value) && args[index + 1] && !args[index + 1].startsWith("--")) options[value] = args[++index];
    else throw new Error(`Opción desconocida o sin valor: ${value}`);
  }
  return { positional, options };
}

async function output(value: unknown, markdown: () => string, options: Record<string, string | boolean>) {
  const format = options["--format"] || "json";
  if (!["json", "markdown"].includes(String(format))) throw new Error("--format debe ser json o markdown.");
  const body = format === "markdown" ? markdown() : JSON.stringify(value, null, 2) + "\n";
  if (options["--out"]) await writeFile(String(options["--out"]), body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  else process.stdout.write(body);
}

async function reportReference(reference: string) {
  if (/^\d{13}-[a-f0-9-]{36}$/.test(reference)) return (await readReport(reference)).report;
  const handle = await open(reference, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Archivo de informe inválido o mayor de 32 MB.");
    const buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > stat.size) throw new Error("El archivo cambió durante la lectura.");
    const value = JSON.parse(buffer.subarray(0, total).toString("utf8"));
    return validateReport(value?.format === "seo-webmaster-audit" ? value.report : value);
  } finally { await handle.close(); }
}

export async function auditCli(command: string, args: string[]) {
  const values = command === "audit" ? ["--max-pages", "--format", "--out", "--gsc", "--bing", "--start", "--end", "--render", "--performance-strategy"]
    : command === "history" ? ["--limit"] : ["--format", "--out"];
  const flags = command === "audit" ? ["--save", "--fail-on-high", "--performance"] : command === "compare" ? ["--fail-on-regression"] : [];
  const { positional, options } = parse(args, values, flags);
  // Validate options before starting a network request or writing a saved report.
  if (options["--format"] && !["json", "markdown"].includes(String(options["--format"]))) throw new Error("--format debe ser json o markdown.");
  if (command === "audit") {
    if (positional.length !== 1) throw new Error("Uso: seo-webmaster-mcp audit URL [--max-pages N] [--save] [--format json|markdown] [--out archivo]");
    const report = await seoAuditAdvanced({ baseUrl: positional[0],
      ...(options["--max-pages"] !== undefined ? { maxPages: Number(options["--max-pages"]) } : {}),
      ...(options["--gsc"] ? { gscSiteUrl: options["--gsc"] } : {}),
      ...(options["--bing"] ? { bingSiteUrl: options["--bing"] } : {}),
      ...(options["--start"] ? { startDate: options["--start"] } : {}),
      ...(options["--end"] ? { endDate: options["--end"] } : {}),
      ...(options["--render"] ? { render: options["--render"] } : {}),
      ...(options["--performance"] ? { performance: true } : {}),
      ...(options["--performance-strategy"] ? { performanceStrategy: options["--performance-strategy"] } : {}),
    });
    const saved = options["--save"] ? await saveReport(report) : undefined;
    await output({ ...report, ...(saved ? { saved } : {}) }, () => (saved ? `Auditoría guardada: ${saved.id}\n\n` : "") + reportMarkdown(report), options);
    process.exitCode = report.status !== "complete" ? 2 : options["--fail-on-high"] && report.actions.some(action => action.priority === "high") ? 3 : 0;
  } else if (command === "history") {
    if (positional.length) throw new Error("Uso: seo-webmaster-mcp history [--limit N]");
    console.log(JSON.stringify(await listReports(options["--limit"] === undefined ? 20 : Number(options["--limit"])), null, 2));
  } else if (command === "report") {
    if (positional.length !== 1) throw new Error("Uso: seo-webmaster-mcp report ID [--format json|markdown] [--out archivo]");
    const saved = await readReport(positional[0]);
    await output(saved.report, () => reportMarkdown(saved.report), options);
  } else if (command === "compare") {
    if (positional.length !== 2) throw new Error("Uso: seo-webmaster-mcp compare ID_O_ARCHIVO_BASE ID_O_ARCHIVO_ACTUAL [--fail-on-regression]");
    const baseline = await reportReference(positional[0]), current = await reportReference(positional[1]);
    const comparison = compareReports(baseline, current);
    await output(comparison, () => comparisonMarkdown(comparison), options);
    process.exitCode = options["--fail-on-regression"] && comparison.new.length ? 3
      : comparison.summary.notComparable || comparison.summary.currentPartial || comparison.summary.baselinePartial ||
        comparison.summary.noHtmlCoverage || comparison.summary.coverageChanged || comparison.summary.incompleteChecks.length || comparison.summary.crawlTruncated ? 2 : 0;
  }
}
