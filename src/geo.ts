import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { credentialsPath } from "./config.js";
import { dateRange, object, requiredString, type JsonObject } from "./utils.js";

type GeoRow = { value: string; impressions: number };
type GeoReport = {
  siteUrl: string; startDate: string; endDate: string; dimension: "page" | "date";
  importedAt: string; rows: GeoRow[]; source: "gsc_generative_ai_csv";
};

function reportPath(siteUrl: string): string {
  const hash = createHash("sha256").update(siteUrl).digest("hex").slice(0, 16);
  return join(dirname(credentialsPath()), `geo-report-${hash}.json`);
}

export async function importGeoReport(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const file = resolve(requiredString(args, "file"));
  const { startDate, endDate } = dateRange(args);
  const dimension = requiredString(args, "dimension");
  if (dimension !== "page" && dimension !== "date") throw new Error("dimension debe ser page o date.");
  const raw = await readFile(file);
  if (raw.byteLength > 5_000_000) throw new Error("El CSV excede 5 MB.");
  const records = parse(raw.toString("utf8"), { columns: true, bom: true, skip_empty_lines: true,
    relax_column_count: false, trim: true }) as Record<string, string>[];
  if (!records.length || records.length > 10000) throw new Error("El CSV debe contener entre 1 y 10000 filas.");
  const first = Object.keys(records[0]);
  const normalize = (value: string) => value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const valueColumn = first.find((key) => dimension === "page"
    ? ["page", "pages", "pagina", "paginas", "url"].includes(normalize(key))
    : ["date", "dates", "fecha", "fechas"].includes(normalize(key)));
  const impressionColumn = first.find((key) => ["impressions", "impresiones"].includes(normalize(key)));
  if (!valueColumn || !impressionColumn) throw new Error("El CSV necesita columnas de dimensión e impresiones.");
  const rows = records.map((record): GeoRow => {
    const value = record[valueColumn]?.trim();
    const rawNumber = record[impressionColumn]?.trim();
    const impressions = rawNumber === "~" || rawNumber === "-" ? 0 : Number(rawNumber?.replace(/,/g, ""));
    if (!value || !Number.isFinite(impressions) || impressions < 0) throw new Error("Fila GEO inválida.");
    if (dimension === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Fecha GEO inválida.");
    if (dimension === "page" && !/^https?:\/\//.test(value)) throw new Error("URL GEO inválida.");
    return { value, impressions };
  });
  const report: GeoReport = { siteUrl, startDate, endDate, dimension, rows,
    importedAt: new Date().toISOString(), source: "gsc_generative_ai_csv" };
  const target = reportPath(siteUrl);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(report), { mode: 0o600, flag: "wx" });
  await rename(temporary, target);
  if (process.platform !== "win32") await chmod(target, 0o600);
  return { siteUrl, startDate, endDate, dimension, rows: rows.length,
    note: "Importación local de impresiones del informe generativo de Google; no incluye citas de otros asistentes." };
}

export async function geoReportSummary(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  let raw: string;
  try { raw = await readFile(reportPath(siteUrl), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { siteUrl, status: "not_imported" };
    throw error;
  }
  const report = object(JSON.parse(raw), "reporte GEO") as GeoReport & JsonObject;
  if (report.siteUrl !== siteUrl) return { siteUrl, status: "not_imported" };
  const rows = (report.rows || []).slice().sort((a, b) => b.impressions - a.impressions);
  return { siteUrl, status: "ok", source: report.source, dimension: report.dimension,
    startDate: report.startDate, endDate: report.endDate, importedAt: report.importedAt,
    rows: rows.slice(0, 20), totalImpressions: report.dimension === "date"
      ? rows.reduce((sum, row) => sum + row.impressions, 0) : null,
    note: "Las filas por página pueden tener una agregación diferente al total de la propiedad." };
}
