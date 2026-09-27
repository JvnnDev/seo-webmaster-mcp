import { OAuth2Client } from "google-auth-library";
import { loadCredentials } from "./config.js";
import { dateRange, object, optionalLimit, requiredString, type JsonObject } from "./utils.js";

const WEBMASTERS_ROOT = "https://www.googleapis.com/webmasters/v3";
const INSPECTION_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
let cachedClient: OAuth2Client | undefined;
let cachedRefreshToken: string | undefined;
let cachedClientId: string | undefined;

export async function googleRequest(method: "GET" | "POST", url: string, body?: unknown): Promise<JsonObject> {
  const credentials = (await loadCredentials()).google;
  if (!credentials) {
    throw new Error("Google Search Console no está conectado. Ejecuta: seo-webmaster-mcp setup google");
  }
  if (!cachedClient || cachedRefreshToken !== credentials.refreshToken || cachedClientId !== credentials.clientId) {
    cachedClient = new OAuth2Client({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
    cachedClient.setCredentials({ refresh_token: credentials.refreshToken });
    cachedRefreshToken = credentials.refreshToken;
    cachedClientId = credentials.clientId;
  }

  let authorization: string | null;
  try {
    authorization = (await cachedClient.getRequestHeaders()).get("authorization");
  } catch {
    throw new Error("No se pudo renovar la conexión con Google. Ejecuta: seo-webmaster-mcp setup google");
  }
  if (!authorization) throw new Error("Google no proporcionó un token de acceso.");

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("No se pudo conectar con Google Search Console.");
  }
  if (!response.ok) throw new Error(`Google Search Console devolvió HTTP ${response.status}.`);
  try {
    return object(await response.json(), "respuesta de Google");
  } catch {
    throw new Error("Google Search Console no devolvió JSON válido.");
  }
}

export async function gscListSites() {
  const response = await googleRequest("GET", `${WEBMASTERS_ROOT}/sites`);
  const entries = Array.isArray(response.siteEntry) ? response.siteEntry : [];
  return { sites: entries.map((entry) => {
    const site = object(entry, "propiedad de Google");
    return { siteUrl: site.siteUrl, permissionLevel: site.permissionLevel };
  }) };
}

export async function gscPerformance(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const { startDate, endDate } = dateRange(args);
  const dimension = args.dimension === undefined ? "date" : requiredString(args, "dimension");
  if (!["date", "query", "page", "country", "device"].includes(dimension)) {
    throw new Error("dimension debe ser date, query, page, country o device.");
  }
  const limit = optionalLimit(args, 1000);
  const response = await googleRequest(
    "POST",
    `${WEBMASTERS_ROOT}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    { startDate, endDate, dimensions: [dimension], rowLimit: limit, dataState: "final" },
  );
  const rows = Array.isArray(response.rows) ? response.rows.map((item) => {
    const row = object(item, "fila de Google");
    for (const field of ["clicks", "impressions", "ctr", "position"]) {
      if (typeof row[field] !== "number" || !Number.isFinite(row[field])) {
        throw new Error("Google devolvió métricas inválidas.");
      }
    }
    return {
      value: Array.isArray(row.keys) ? row.keys[0] : null,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    };
  }) : [];
  if (dimension === "date") {
    rows.sort((a, b) => String(a.value).localeCompare(String(b.value)));
  }
  const mayBeTruncated = rows.length === limit;
  const totals = dimension === "date" && rows.length > 0 && !mayBeTruncated ? {
    clicks: rows.reduce((sum, row) => sum + Number(row.clicks), 0),
    impressions: rows.reduce((sum, row) => sum + Number(row.impressions), 0),
  } : null;
  return {
    siteUrl,
    startDate,
    endDate,
    dimension,
    status: rows.length === 0 ? "no_data_in_range" : "ok",
    totals,
    mayBeTruncated,
    note: dimension === "date"
      ? "Los días sin datos se omiten."
      : "Google puede limitar los resultados por dimensión a las filas principales.",
    rows,
  };
}

export async function gscPagePerformance(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const url = requiredString(args, "url");
  const { startDate, endDate } = dateRange(args);
  const endpoint = `${WEBMASTERS_ROOT}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const filter = {
    groupType: "and",
    filters: [{ dimension: "page", operator: "equals", expression: url }],
  };
  const base = { startDate, endDate, type: "web", dataState: "final", dimensionFilterGroups: [filter] };
  const [dailyResponse, queryResponse] = await Promise.all([
    googleRequest("POST", endpoint, { ...base, dimensions: ["date"], rowLimit: 1000 }),
    googleRequest("POST", endpoint, { ...base, dimensions: ["query"], rowLimit: 100 }),
  ]);
  const daily = parseAnalyticsRows(dailyResponse).sort((a, b) => String(a.value).localeCompare(String(b.value)));
  const topQueries = parseAnalyticsRows(queryResponse);
  return {
    siteUrl,
    url,
    startDate,
    endDate,
    status: daily.length === 0 ? "no_data_in_range" : "ok",
    totals: daily.length === 0 || daily.length === 1000 ? null : {
      clicks: daily.reduce((sum, row) => sum + row.clicks, 0),
      impressions: daily.reduce((sum, row) => sum + row.impressions, 0),
    },
    daily,
    topQueries,
    note: "La URL debe coincidir con la página registrada por Google; algunas consultas se omiten por privacidad.",
  };
}

export async function gscOpportunities(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const { startDate, endDate } = dateRange(args);
  const limit = optionalLimit(args, 20, 100);
  const minImpressions = args.minImpressions === undefined ? 50 : args.minImpressions;
  if (typeof minImpressions !== "number" || !Number.isInteger(minImpressions) || minImpressions < 1) {
    throw new Error("minImpressions debe ser un entero positivo.");
  }
  const performance = await gscPerformance({ siteUrl, startDate, endDate, dimension: "query", limit: 1000 });
  const candidates = performance.rows.flatMap((row) => {
    if (Number(row.impressions) < minImpressions) return [];
    const position = Number(row.position);
    const ctr = Number(row.ctr);
    const reason = position <= 10 && ctr < 0.02
      ? "low_ctr_top_10"
      : position > 10 && position <= 20
        ? "near_first_page"
        : undefined;
    return reason ? [{ ...row, reason }] : [];
  }).sort((a, b) => Number(b.impressions) - Number(a.impressions)).slice(0, limit);
  return {
    siteUrl,
    startDate,
    endDate,
    criteria: { minImpressions, lowCtrBelow: 0.02, topPositionAtMost: 10, nearFirstPagePosition: [10, 20] },
    candidates,
    sampleMayBeTruncated: performance.mayBeTruncated,
    note: "Son señales para investigar, no errores SEO. Search Console puede omitir consultas anonimizadas.",
  };
}

function parseAnalyticsRows(response: JsonObject): Array<{
  value: unknown;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}> {
  if (!Array.isArray(response.rows)) return [];
  return response.rows.map((item) => {
    const row = object(item, "fila de Google");
    for (const field of ["clicks", "impressions", "ctr", "position"]) {
      if (typeof row[field] !== "number" || !Number.isFinite(row[field])) {
        throw new Error("Google devolvió métricas inválidas.");
      }
    }
    return {
      value: Array.isArray(row.keys) ? row.keys[0] : null,
      clicks: row.clicks as number,
      impressions: row.impressions as number,
      ctr: row.ctr as number,
      position: row.position as number,
    };
  });
}

export async function gscSitemaps(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const response = await googleRequest(
    "GET",
    `${WEBMASTERS_ROOT}/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
  );
  return { siteUrl, sitemaps: Array.isArray(response.sitemap) ? response.sitemap : [] };
}

export async function gscSitemapDetails(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const sitemapUrl = requiredString(args, "sitemapUrl");
  const response = await googleRequest(
    "GET",
    `${WEBMASTERS_ROOT}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
  );
  return { siteUrl, sitemapUrl, sitemap: response };
}

/** Search Analytics exposes top rows, not a complete census of queries. */
export async function gscQueryAdvanced(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const { startDate, endDate } = dateRange(args);
  const allowed = ["date", "query", "page", "country", "device", "searchAppearance"];
  const dimensions = args.dimensions === undefined ? ["query", "page"] : args.dimensions;
  if (!Array.isArray(dimensions) || dimensions.length < 1 || dimensions.length > 3 ||
      dimensions.some((d) => typeof d !== "string" || !allowed.includes(d)) ||
      new Set(dimensions).size !== dimensions.length) {
    throw new Error("dimensions debe contener de 1 a 3 dimensiones distintas admitidas.");
  }
  const limit = optionalLimit(args, 1000, 25000);
  const startRow = args.startRow === undefined ? 0 : args.startRow;
  if (!Number.isInteger(startRow) || (startRow as number) < 0 || (startRow as number) > 50000) {
    throw new Error("startRow debe estar entre 0 y 50000.");
  }
  const type = args.type === undefined ? "web" : requiredString(args, "type");
  if (!["web", "image", "video", "news", "discover", "googleNews"].includes(type)) {
    throw new Error("type no es un tipo de búsqueda admitido.");
  }
  const filters = args.filters === undefined ? [] : args.filters;
  if (!Array.isArray(filters) || filters.length > 5) throw new Error("filters admite hasta 5 filtros.");
  const parsedFilters = filters.map((value) => {
    const filter = object(value, "filtro");
    const dimension = requiredString(filter, "dimension");
    const operator = requiredString(filter, "operator");
    const expression = requiredString(filter, "expression");
    if (!["query", "page", "country", "device", "searchAppearance"].includes(dimension) ||
        !["contains", "equals", "notContains", "notEquals", "includingRegex", "excludingRegex"].includes(operator)) {
      throw new Error("Filtro de Search Analytics inválido.");
    }
    return { dimension, operator, expression };
  });
  const body = {
    startDate, endDate, dimensions, type, rowLimit: limit, startRow,
    dataState: "final",
    ...(parsedFilters.length ? { dimensionFilterGroups: [{ groupType: "and", filters: parsedFilters }] } : {}),
  };
  const response = await googleRequest("POST", `${WEBMASTERS_ROOT}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, body);
  const rows = Array.isArray(response.rows) ? response.rows.map((value) => {
    const row = object(value, "fila de Google");
    for (const field of ["clicks", "impressions", "ctr", "position"]) {
      if (typeof row[field] !== "number" || !Number.isFinite(row[field])) {
        throw new Error("Google devolvió métricas inválidas.");
      }
    }
    return {
      keys: Array.isArray(row.keys) ? row.keys : [],
      clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position,
    };
  }) : [];
  return { siteUrl, startDate, endDate, dimensions, type, startRow, limit, rows,
    nextStartRow: rows.length === limit ? (startRow as number) + rows.length : null,
    note: "Google devuelve filas principales y puede omitir consultas anonimizadas." };
}

export async function gscInspectUrl(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const url = requiredString(args, "url");
  const response = await googleRequest("POST", INSPECTION_URL, {
    siteUrl,
    inspectionUrl: url,
  });
  return { siteUrl, url, inspectionResult: response.inspectionResult ?? null };
}
