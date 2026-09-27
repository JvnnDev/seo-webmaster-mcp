import { loadCredentials } from "./config.js";
import {
  bingDate,
  cleanBing,
  dateRange,
  object,
  optionalLimit,
  optionalPage,
  requiredString,
  resultArray,
  type JsonObject,
} from "./utils.js";

const ROOT = "https://ssl.bing.com/webmaster/api.svc/json/";

export async function bingRequest(
  method: string,
  params: Record<string, string> = {},
  providedKey?: string,
): Promise<unknown> {
  const key = providedKey || (await loadCredentials()).bingApiKey;
  if (!key) throw new Error("Bing no está conectado. Ejecuta: seo-webmaster-mcp setup bing");

  const url = new URL(method, ROOT);
  url.searchParams.set("apikey", key);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("No se pudo conectar con Bing Webmaster Tools.");
  }
  if (!response.ok) throw new Error(`Bing devolvió HTTP ${response.status}.`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Bing no devolvió JSON válido.");
  }
  const envelope = object(payload, "respuesta de Bing");
  if (!("d" in envelope)) throw new Error("Bing devolvió un formato inesperado.");
  return envelope.d;
}

export async function bingListSites() {
  const sites = resultArray(await bingRequest("GetUserSites"), "Bing");
  return {
    sites: sites.map((site) => ({
      siteUrl: site.Url,
      isVerified: site.IsVerified,
    })),
  };
}

export async function bingPerformance(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const { startDate, endDate } = dateRange(args);
  const source = resultArray(await bingRequest("GetRankAndTrafficStats", { siteUrl }), "Bing");
  const daily = source.map((row) => {
    if (typeof row.Clicks !== "number" || typeof row.Impressions !== "number") {
      throw new Error("Bing devolvió métricas inválidas.");
    }
    return { date: bingDate(row.Date), clicks: row.Clicks, impressions: row.Impressions };
  }).filter((row) => row.date >= startDate && row.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    siteUrl,
    startDate,
    endDate,
    status: source.length === 0 ? "no_data_from_bing" : daily.length === 0 ? "no_data_in_range" : "ok",
    totals: daily.length === 0 ? null : {
      clicks: daily.reduce((sum, row) => sum + row.clicks, 0),
      impressions: daily.reduce((sum, row) => sum + row.impressions, 0),
    },
    daily,
  };
}

export async function bingTop(args: JsonObject, kind: "query" | "page") {
  const siteUrl = requiredString(args, "siteUrl");
  const limit = optionalLimit(args);
  const method = kind === "query" ? "GetQueryStats" : "GetPageStats";
  const source = resultArray(await bingRequest(method, { siteUrl }), "Bing");
  const rows = source.map((row) => ({
    // Bing uses QueryStats.Query for both query text and page URLs.
    [kind]: row.Query,
    date: bingDate(row.Date),
    clicks: row.Clicks,
    impressions: row.Impressions,
    avgClickPosition: row.AvgClickPosition,
    avgImpressionPosition: row.AvgImpressionPosition,
  })).sort((a, b) => Number(b.clicks) - Number(a.clicks)).slice(0, limit);
  return {
    siteUrl,
    status: source.length === 0 ? "no_data_from_bing" : "ok",
    note: "Bing entrega estadísticas semanales de consultas y páginas principales.",
    rows,
  };
}

export async function bingFeedDetails(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const feedUrl = requiredString(args, "feedUrl");
  return { siteUrl, feedUrl, details: cleanBing(await bingRequest("GetFeedDetails", { siteUrl, feedUrl })) };
}

export async function bingPageQueries(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const pageUrl = requiredString(args, "pageUrl");
  return { siteUrl, pageUrl, rows: cleanBing(await bingRequest("GetPageQueryStats", { siteUrl, page: pageUrl })) };
}

export async function bingQueryPages(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const query = requiredString(args, "query");
  return { siteUrl, query, rows: cleanBing(await bingRequest("GetQueryPageStats", { siteUrl, query })) };
}

export async function bingCrawlIssues(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const limit = optionalLimit(args);
  const issues = resultArray(await bingRequest("GetCrawlIssues", { siteUrl }), "Bing");
  return {
    siteUrl,
    issues: cleanBing(issues.slice(0, limit)),
    total: issues.length,
    returned: Math.min(issues.length, limit),
  };
}

export async function bingCrawlStats(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const stats = await bingRequest("GetCrawlStats", { siteUrl });
  return { siteUrl, stats: cleanBing(stats) };
}

export async function bingSitemaps(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const feeds = resultArray(await bingRequest("GetFeeds", { siteUrl }), "Bing");
  return { siteUrl, sitemaps: cleanBing(feeds) };
}

export async function bingUrlInfo(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const url = requiredString(args, "url");
  return { siteUrl, url, info: cleanBing(await bingRequest("GetUrlInfo", { siteUrl, url })) };
}

export async function bingBacklinkPages(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const page = optionalPage(args);
  const result = object(await bingRequest("GetLinkCounts", { siteUrl, page: String(page) }), "enlaces de Bing");
  return {
    siteUrl,
    page,
    totalPages: result.TotalPages,
    links: cleanBing(resultArray(result.Links, "Bing")),
  };
}

export async function bingBacklinkSources(args: JsonObject) {
  const siteUrl = requiredString(args, "siteUrl");
  const link = requiredString(args, "link");
  const page = optionalPage(args);
  const result = object(await bingRequest("GetUrlLinks", { siteUrl, link, page: String(page) }), "enlaces de Bing");
  return {
    siteUrl,
    link,
    page,
    totalPages: result.TotalPages,
    sources: cleanBing(resultArray(result.Details, "Bing")),
  };
}

export function bingPortalTools(args: JsonObject) {
  const tool = requiredString(args, "tool");
  const helpUrl = tool === "robots_tester"
    ? "https://www.bing.com/webmasters/help/robots-txt-tester-623520ca"
    : tool === "site_scan"
      ? "https://www.bing.com/webmasters/help/site-scan-623520c9"
      : undefined;
  if (!helpUrl) throw new Error("tool debe ser robots_tester o site_scan.");
  return {
    tool,
    portalUrl: "https://www.bing.com/webmasters/",
    helpUrl,
    message: "Abre el portal, selecciona el sitio y usa la herramienta indicada. Bing no publica esta función en su API.",
  };
}
