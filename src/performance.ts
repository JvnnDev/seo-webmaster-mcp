import { safeUrl } from "./crawl.js";
import { object } from "./utils.js";

const metric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// A Lighthouse run is lab data. CrUX distributions, when supplied by PSI, are
// reported separately, including whether they describe this URL or its origin.
export async function pageSpeedReport(baseUrl: string, strategy: "mobile" | "desktop" = "mobile") {
  if (!["mobile", "desktop"].includes(strategy)) throw new Error("strategy debe ser mobile o desktop.");
  await safeUrl(baseUrl);
  const address = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  address.searchParams.set("url", baseUrl);
  address.searchParams.set("strategy", strategy);
  address.searchParams.set("category", "performance");
  const key = process.env.PAGESPEED_API_KEY;
  if (key) address.searchParams.set("key", key);
  let response: Response;
  try { response = await fetch(address, { signal: AbortSignal.timeout(60_000), redirect: "error" }); }
  catch { throw new Error("PageSpeed Insights no respondió dentro del límite o falló la conexión."); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`PageSpeed Insights devolvió HTTP ${response.status}. Revisa cuota o configuración de la API.`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("PageSpeed Insights devolvió una respuesta vacía.");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 8_000_000) { await reader.cancel(); throw new Error("La respuesta de PageSpeed Insights supera 8 MB."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let payload: Record<string, unknown>;
  try { payload = object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { throw new Error("PageSpeed Insights devolvió JSON inválido."); }
  const lighthouse = record(payload.lighthouseResult), audits = record(lighthouse.audits);
  if (lighthouse.runtimeError) throw new Error("Lighthouse no pudo completar la medición; se conserva la auditoría HTML.");
  if (!Object.keys(lighthouse).length && !payload.loadingExperience && !payload.originLoadingExperience) throw new Error("PageSpeed Insights no devolvió mediciones reconocibles.");
  const labMetric = (name: string) => metric(record(audits[name]).numericValue);
  const score = metric(record(record(lighthouse.categories).performance).score);
  const field = (value: unknown, scope: "url" | "origin") => {
    const experience = record(value), metrics = record(experience.metrics);
    const percentile = (name: string) => metric(record(metrics[name]).percentile);
    const lcp = percentile("LARGEST_CONTENTFUL_PAINT_MS"), inp = percentile("INTERACTION_TO_NEXT_PAINT"), cls = percentile("CUMULATIVE_LAYOUT_SHIFT_SCORE");
    return { scope, id: typeof experience.id === "string" ? experience.id : null,
      available: [lcp, inp, cls].some(value => value !== null),
      p75: { lcpMs: lcp, inpMs: inp, cls: cls === null ? null : cls / 100 },
      category: typeof experience.overall_category === "string" ? experience.overall_category : null };
  };
  return { requestedUrl: baseUrl, strategy, source: "PageSpeed Insights", measuredAt: typeof payload.analysisUTCTimestamp === "string" ? payload.analysisUTCTimestamp : new Date().toISOString(),
    lab: { available: Object.keys(lighthouse).length > 0, performanceScore: score === null || score > 1 ? null : Math.round(score * 100),
      metrics: { lcpMs: labMetric("largest-contentful-paint"), cls: labMetric("cumulative-layout-shift"),
        tbtMs: labMetric("total-blocking-time"), fcpMs: labMetric("first-contentful-paint") } },
    field: { url: field(payload.loadingExperience, "url"), origin: field(payload.originLoadingExperience, "origin") },
    limitations: ["La puntuación Lighthouse corresponde a una ejecución de laboratorio, no demuestra aprobar Core Web Vitals reales.",
      "CrUX solo se muestra cuando la API aporta datos; los percentiles del origen no se atribuyen a una URL individual. Ausencia de datos no significa cero."] };
}
