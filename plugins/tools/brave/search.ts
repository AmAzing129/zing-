export const BRAVE_PLUGIN_ID = "brave";

export type WebSearchInput = { query: string; maxResults?: number };
export type WebSearchHit = { title: string; url: string; snippet: string };
export type WebSearchOutput = { results: WebSearchHit[] };
export type BraveWebSearch = { execute: (input: WebSearchInput, signal?: AbortSignal) => Promise<WebSearchOutput> };
type BraveWebResult = { title?: string; url?: string; description?: string };
type BraveSearchResponse = { web?: { results?: BraveWebResult[] } };
export type BraveWebSearchOptions = { apiKey: string; fetch?: typeof fetch };

export function createBraveWebSearch(options: BraveWebSearchOptions): BraveWebSearch {
  const fetchFn = options.fetch ?? fetch;
  return {
    async execute(input, signal) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", input.query);
      url.searchParams.set("count", String(input.maxResults ?? 5));
      const response = await fetchFn(url, { headers: { Accept: "application/json", "X-Subscription-Token": options.apiKey }, signal });
      if (!response.ok) throw new Error(`Brave search failed: ${response.status}`);
      const data = (await response.json()) as BraveSearchResponse;
      return { results: (data.web?.results ?? []).filter((item): item is BraveWebResult & { url: string } => Boolean(item.url)).map((item) => ({ title: item.title ?? "", url: item.url, snippet: item.description ?? "" })) };
    },
  };
}
