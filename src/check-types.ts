import type { CrawlPage } from "./crawl.js";

export type Action = {
  code: string; priority: "high" | "medium" | "low"; confidence: "verified" | "inferred";
  title: string; affectedUrls: string[]; evidence: unknown; steps: string[];
  verification: string; effort: "low" | "medium" | "high";
  source: "google" | "bing" | "crawl" | "crosscheck" | "analysis";
  observedAt: string;
  impact: { metric: "affected_pages" | "impressions"; value: number } | null;
};


export type CheckContext = { pages: CrawlPage[]; sitemapUrls: string[] };
export type CheckModule = {
  id: string; version: number; scope: "page" | "site";
  run(context: CheckContext): Action[];
  incomplete?(context: CheckContext): string[];
};

export function add(actions: Action[], action: Omit<Action, "source" | "observedAt" | "impact"> &
  Partial<Pick<Action, "source" | "impact">>) {
  const source = action.source || (action.code.startsWith("google_") ? "google" :
    action.code.startsWith("bing_") ? "bing" : action.code === "query_page_opportunities" ? "analysis" : "crawl");
  const evidence = action.evidence as { count?: number } | null;
  actions.push({ ...action, source, observedAt: new Date().toISOString(),
    impact: action.impact || (typeof evidence?.count === "number"
      ? { metric: "affected_pages", value: evidence.count } : null) });
}
