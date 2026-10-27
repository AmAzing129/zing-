import { Type } from "@earendil-works/pi-ai";
import type { ZingPluginAPI } from "zing";
import { createBraveWebSearch, type BraveWebSearch } from "./search";

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_SEARCH_DESCRIPTION =
  "Search the public web and return a ranked list of relevant sources. " +
  "Use for current facts, news, or anything not in your training data.";
export const webSearchParameters = Type.Object({
  query: Type.String({ minLength: 1, description: "Search query" }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum number of results to return (1-10)" })),
});

export { BRAVE_PLUGIN_ID, createBraveWebSearch } from "./search";

export default function brave(zing: ZingPluginAPI) {
  let search: BraveWebSearch | undefined;
  zing.registerTool({
    name: WEB_SEARCH_TOOL_NAME,
    description: WEB_SEARCH_DESCRIPTION,
    parameters: webSearchParameters,
    readOnly: true,
    execute: async (input, { signal }) => {
      search ??= createBraveWebSearch({ apiKey: zing.requireEnv("BRAVE_API_KEY") });
      const result = await search.execute({ query: String(input.query).trim(), maxResults: typeof input.maxResults === "number" ? input.maxResults : undefined }, signal);
      return { text: JSON.stringify(result), details: result };
    },
  });
}
