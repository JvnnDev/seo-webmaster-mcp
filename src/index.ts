import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  bingBacklinkPages,
  bingBacklinkSources,
  bingCrawlIssues,
  bingCrawlStats,
  bingFeedDetails,
  bingListSites,
  bingPageQueries,
  bingPerformance,
  bingPortalTools,
  bingSitemaps,
  bingTop,
  bingQueryPages,
  bingUrlInfo,
} from "./bing.js";
import {
  gscInspectUrl,
  gscListSites,
  gscOpportunities,
  gscPagePerformance,
  gscPerformance,
  gscQueryAdvanced,
  gscSitemapDetails,
  gscSitemaps,
} from "./google.js";
import { seoAuditSite } from "./audit.js";
import { seoAuditAdvanced } from "./advanced.js";
import { geoReportSummary } from "./geo.js";
import { object, type JsonObject } from "./utils.js";

const siteUrl = { type: "string" as const, description: "URL exacta de la propiedad verificada." };
const date = {
  type: "string" as const,
  format: "date",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "Fecha YYYY-MM-DD.",
};
const limit = { type: "integer" as const, minimum: 1, maximum: 1000, default: 100 };
const gscLimit = { type: "integer" as const, minimum: 1, maximum: 1000, default: 1000 };
const url = { type: "string" as const, description: "URL completa que pertenece al sitio." };
const page = { type: "integer" as const, minimum: 0, maximum: 32767, default: 0 };

const tools: Tool[] = [
  {
    name: "bing_list_sites",
    description: "Lista los sitios de Bing Webmaster Tools y su estado de verificación.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_bing_clicks_and_impressions",
    description: "Métricas diarias de Bing para un rango inclusivo. Bing puede tardar en disponer de datos de sitios nuevos.",
    inputSchema: {
      type: "object", properties: { siteUrl, startDate: date, endDate: date },
      required: ["siteUrl", "startDate", "endDate"], additionalProperties: false,
    },
  },
  {
    name: "bing_top_queries",
    description: "Consultas principales de Bing. La fuente se actualiza semanalmente.",
    inputSchema: {
      type: "object", properties: { siteUrl, limit }, required: ["siteUrl"], additionalProperties: false,
    },
  },
  {
    name: "bing_top_pages",
    description: "Páginas principales de Bing. La fuente se actualiza semanalmente.",
    inputSchema: {
      type: "object", properties: { siteUrl, limit }, required: ["siteUrl"], additionalProperties: false,
    },
  },
  {
    name: "bing_crawl_issues",
    description: "Problemas de rastreo detectados por Bing.",
    inputSchema: {
      type: "object", properties: { siteUrl, limit }, required: ["siteUrl"], additionalProperties: false,
    },
  },
  {
    name: "bing_crawl_stats",
    description: "Estadísticas de rastreo de Bing.",
    inputSchema: {
      type: "object", properties: { siteUrl }, required: ["siteUrl"], additionalProperties: false,
    },
  },
  {
    name: "bing_sitemaps",
    description: "Lista los sitemaps enviados a Bing y su estado.",
    inputSchema: {
      type: "object", properties: { siteUrl }, required: ["siteUrl"], additionalProperties: false,
    },
  },
  {
    name: "bing_url_info",
    description: "Información de rastreo e indexación de una URL según la API de Bing.",
    inputSchema: {
      type: "object", properties: { siteUrl, url }, required: ["siteUrl", "url"], additionalProperties: false,
    },
  },
  {
    name: "bing_backlink_pages",
    description: "Páginas del sitio con enlaces entrantes según Bing, paginadas desde 0.",
    inputSchema: {
      type: "object", properties: { siteUrl, page }, required: ["siteUrl"], additionalProperties: false,
    },
  },
  {
    name: "bing_backlink_sources",
    description: "URLs y textos ancla que enlazan a una página del sitio según Bing.",
    inputSchema: {
      type: "object", properties: { siteUrl, link: url, page },
      required: ["siteUrl", "link"], additionalProperties: false,
    },
  },
  {
    name: "bing_portal_tools",
    description: "Enlaces oficiales a Robots.txt Tester o Site Scan de Bing; estas herramientas no tienen API pública.",
    inputSchema: {
      type: "object", properties: {
        tool: { type: "string", enum: ["robots_tester", "site_scan"] },
      }, required: ["tool"], additionalProperties: false,
    },
  },
  {
    name: "gsc_list_sites",
    description: "Lista las propiedades accesibles en Google Search Console.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "gsc_search_performance",
    description: "Clics, impresiones, CTR y posición de Google Search Console por fecha, consulta, página, país o dispositivo.",
    inputSchema: {
      type: "object", properties: {
        siteUrl, startDate: date, endDate: date,
        dimension: { type: "string", enum: ["date", "query", "page", "country", "device"], default: "date" },
        limit: gscLimit,
      }, required: ["siteUrl", "startDate", "endDate"], additionalProperties: false,
    },
  },
  {
    name: "gsc_sitemaps",
    description: "Lista los sitemaps de una propiedad de Google Search Console.",
    inputSchema: {
      type: "object", properties: { siteUrl }, required: ["siteUrl"], additionalProperties: false,
    },
  },
  {
    name: "gsc_inspect_url",
    description: "Consulta el estado de indexación de una URL que Google tiene registrado; no ejecuta una prueba en vivo.",
    inputSchema: {
      type: "object", properties: { siteUrl, url }, required: ["siteUrl", "url"], additionalProperties: false,
    },
  },
  {
    name: "gsc_page_performance",
    description: "Serie diaria y consultas principales de una página exacta en Google Search Console.",
    inputSchema: {
      type: "object", properties: { siteUrl, url, startDate: date, endDate: date },
      required: ["siteUrl", "url", "startDate", "endDate"], additionalProperties: false,
    },
  },
  {
    name: "gsc_opportunities",
    description: "Consultas que conviene investigar por bajo CTR en top 10 o posición media entre 10 y 20; son heurísticas, no errores oficiales.",
    inputSchema: {
      type: "object", properties: {
        siteUrl, startDate: date, endDate: date,
        minImpressions: { type: "integer", minimum: 1, default: 50 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      }, required: ["siteUrl", "startDate", "endDate"], additionalProperties: false,
    },
  },
  {
    name: "seo_audit_site",
    description: "Auditoría resumida de Bing y/o Search Console con evidencia, hallazgos priorizados y errores parciales.",
    inputSchema: {
      type: "object", properties: {
        bingSiteUrl: siteUrl,
        gscSiteUrl: siteUrl,
        startDate: date,
        endDate: date,
        url,
      }, required: ["startDate", "endDate"], additionalProperties: false,
    },
  },
  {
    name: "gsc_query_advanced",
    description: "Search Analytics con 1-3 dimensiones, filtros y paginación; Google puede limitar filas.",
    inputSchema: { type: "object", properties: {
      siteUrl, startDate: date, endDate: date,
      dimensions: { type: "array", items: { type: "string", enum: ["date", "query", "page", "country", "device", "searchAppearance"] }, minItems: 1, maxItems: 3 },
      type: { type: "string", enum: ["web", "image", "video", "news", "discover", "googleNews"] },
      startRow: { type: "integer", minimum: 0, maximum: 50000 },
      limit: { type: "integer", minimum: 1, maximum: 25000 },
      filters: { type: "array", maxItems: 5, items: { type: "object", properties: {
        dimension: { type: "string", enum: ["query", "page", "country", "device", "searchAppearance"] },
        operator: { type: "string", enum: ["contains", "equals", "notContains", "notEquals", "includingRegex", "excludingRegex"] },
        expression: { type: "string" },
      }, required: ["dimension", "operator", "expression"], additionalProperties: false } },
    }, required: ["siteUrl", "startDate", "endDate"], additionalProperties: false },
  },
  { name: "gsc_sitemap_details", description: "Detalle oficial de un sitemap enviado a Search Console.",
    inputSchema: { type: "object", properties: { siteUrl, sitemapUrl: url },
      required: ["siteUrl", "sitemapUrl"], additionalProperties: false } },
  { name: "bing_feed_details", description: "Detalle oficial de un sitemap o índice de Bing.",
    inputSchema: { type: "object", properties: { siteUrl, feedUrl: url },
      required: ["siteUrl", "feedUrl"], additionalProperties: false } },
  { name: "bing_page_queries", description: "Consultas asociadas a una página en Bing.",
    inputSchema: { type: "object", properties: { siteUrl, pageUrl: url },
      required: ["siteUrl", "pageUrl"], additionalProperties: false } },
  { name: "bing_query_pages", description: "Páginas asociadas a una consulta en Bing.",
    inputSchema: { type: "object", properties: { siteUrl, query: { type: "string" } },
      required: ["siteUrl", "query"], additionalProperties: false } },
  { name: "geo_report_summary", description: "Resumen del último CSV generativo de Google importado localmente.",
    inputSchema: { type: "object", properties: { siteUrl }, required: ["siteUrl"], additionalProperties: false } },
  { name: "seo_audit_advanced", description: "Auditoría avanzada SEO y GEO: APIs oficiales, rastreo acotado y plan de acción con evidencia.",
    inputSchema: { type: "object", properties: { bingSiteUrl: siteUrl, gscSiteUrl: siteUrl,
      baseUrl: url, startDate: date, endDate: date,
      maxPages: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    }, required: ["baseUrl"], additionalProperties: false } },
];

async function callTool(name: string, args: JsonObject): Promise<unknown> {
  switch (name) {
    case "bing_list_sites": return bingListSites();
    case "get_bing_clicks_and_impressions": return bingPerformance(args);
    case "bing_top_queries": return bingTop(args, "query");
    case "bing_top_pages": return bingTop(args, "page");
    case "bing_crawl_issues": return bingCrawlIssues(args);
    case "bing_crawl_stats": return bingCrawlStats(args);
    case "bing_sitemaps": return bingSitemaps(args);
    case "bing_url_info": return bingUrlInfo(args);
    case "bing_backlink_pages": return bingBacklinkPages(args);
    case "bing_backlink_sources": return bingBacklinkSources(args);
    case "bing_portal_tools": return bingPortalTools(args);
    case "gsc_list_sites": return gscListSites();
    case "gsc_search_performance": return gscPerformance(args);
    case "gsc_sitemaps": return gscSitemaps(args);
    case "gsc_inspect_url": return gscInspectUrl(args);
    case "gsc_page_performance": return gscPagePerformance(args);
    case "gsc_opportunities": return gscOpportunities(args);
    case "seo_audit_site": return seoAuditSite(args);
    case "gsc_query_advanced": return gscQueryAdvanced(args);
    case "gsc_sitemap_details": return gscSitemapDetails(args);
    case "bing_feed_details": return bingFeedDetails(args);
    case "bing_page_queries": return bingPageQueries(args);
    case "bing_query_pages": return bingQueryPages(args);
    case "geo_report_summary": return geoReportSummary(args);
    case "seo_audit_advanced": return seoAuditAdvanced(args);
    default: throw new Error(`Herramienta desconocida: ${name}`);
  }
}

const server = new Server(
  { name: "seo-webmaster-mcp", version: "0.3.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = request.params.arguments === undefined ? {} : object(request.params.arguments, "arguments");
    const result = await callTool(request.params.name, args);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado.";
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    };
  }
});

server.connect(new StdioServerTransport()).catch((error: unknown) => {
  console.error("No se pudo iniciar el servidor MCP:", error);
  process.exitCode = 1;
});
