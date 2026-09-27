export type JsonObject = Record<string, unknown>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BING_DATE_PATTERN = /^\/Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)\/$/;

export function object(value: unknown, label = "objeto"): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} debe ser un objeto.`);
  }
  return value as JsonObject;
}

export function requiredString(args: JsonObject, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} debe ser una cadena no vacía.`);
  }
  return value.trim();
}

export function optionalLimit(args: JsonObject, fallback = 100, maximum = 1000): number {
  const value = args.limit;
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`limit debe ser un entero entre 1 y ${maximum}.`);
  }
  return value;
}

export function optionalPage(args: JsonObject): number {
  const value = args.page;
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 32767) {
    throw new Error("page debe ser un entero entre 0 y 32767.");
  }
  return value;
}

export function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function dateRange(args: JsonObject): { startDate: string; endDate: string } {
  const startDate = requiredString(args, "startDate");
  const endDate = requiredString(args, "endDate");
  if (!validDate(startDate) || !validDate(endDate)) {
    throw new Error("startDate y endDate deben ser fechas válidas YYYY-MM-DD.");
  }
  if (startDate > endDate) throw new Error("startDate no puede ser posterior a endDate.");
  return { startDate, endDate };
}

export function bingDate(value: unknown): string {
  if (typeof value !== "string") throw new Error("Bing devolvió una fecha inválida.");
  const match = BING_DATE_PATTERN.exec(value);
  if (match) {
    const milliseconds = Number(match[1]);
    const offsetMinutes = match[2]
      ? (match[2] === "+" ? 1 : -1) * (Number(match[3]) * 60 + Number(match[4]))
      : 0;
    const date = new Date(milliseconds + offsetMinutes * 60_000);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  if (validDate(value)) return value;
  throw new Error("Bing devolvió una fecha inválida.");
}

export function cleanBing(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanBing);
  if (typeof value === "string" && BING_DATE_PATTERN.test(value)) {
    return new Date(Number(BING_DATE_PATTERN.exec(value)![1])).toISOString();
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "__type").map(([key, item]) => [key, cleanBing(item)]),
    );
  }
  return value;
}

export function resultArray(value: unknown, source: string): JsonObject[] {
  if (!Array.isArray(value)) throw new Error(`${source} devolvió un formato inesperado.`);
  return value.map((item) => object(item, `fila de ${source}`));
}
