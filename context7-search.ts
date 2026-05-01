import { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { getApiKey, renderTruncatedToolResult } from "./lib/search-shared.js";

const API_BASE = "https://context7.com/api/v2";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const apiKey = getApiKey("context7");
    if (!apiKey) {
      ctx.ui.notify("Context7 extension loaded. Set API key using /set-keys.", "warning");
    } else {
      ctx.ui.notify("Context7 extension loaded.", "info");
    }
  });

  const headers = () => ({
    "Authorization": `Bearer ${getApiKey("context7") || ""}`,
    "Content-Type": "application/json"
  });

  // Search Library Tool
  pi.registerTool({
    name: "context7_search_library",
    label: "Context7 Search Library",
    description: "Search for programming libraries in Context7 by name",
    promptSnippet: "Search for programming libraries in Context7 by name",
    parameters: Type.Object({
      libraryName: Type.String({ description: "Name of the library to search for (e.g., 'react', 'next.js')" }),
      query: Type.Optional(Type.String({ description: "Optional query to find the most relevant library based on what you want to do" })),
    }),
    renderCall(args, theme, context) {
      if (!context.expanded) return undefined;
      const query = args.query ? ` ${theme.fg("dim", String(args.query))}` : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("context7 search"))} ${theme.fg("accent", args.libraryName)}${query}`, 0, 0);
    },
    renderResult: renderTruncatedToolResult,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = getApiKey("context7");
      if (!apiKey) throw new Error("Context7 API Key not set. Use /set-keys to configure.");
      
      try {
        const url = new URL(`${API_BASE}/libs/search`);
        url.searchParams.append("libraryName", params.libraryName);
        if (params.query) url.searchParams.append("query", params.query);

        const response = await fetch(url.toString(), { headers: headers(), signal });
        
        if (!response.ok) {
          throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          details: data
        };
      } catch (error: any) {
        throw new Error(`Fetch error: ${error.message}`);
      }
    }
  });

  // Get Context Tool
  pi.registerTool({
    name: "context7_get_context",
    label: "Context7 Get Context",
    description: "Retrieve documentation context snippets for a library using Context7",
    promptSnippet: "Retrieve documentation snippets for a specific library from Context7",
    parameters: Type.Object({
      libraryId: Type.String({ description: "The ID of the library from a previous search (e.g., '/vercel/next.js')" }),
      query: Type.String({ description: "The specific question or topic to get documentation for" }),
      type: Type.Optional(Type.String({ description: "Format: json or markdown" })),
    }),
    renderCall(args, theme, context) {
      if (!context.expanded) return undefined;
      return new Text(`${theme.fg("toolTitle", theme.bold("context7 context"))} ${theme.fg("accent", args.libraryId)} ${theme.fg("dim", String(args.query))}`, 0, 0);
    },
    renderResult: renderTruncatedToolResult,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
       const apiKey = getApiKey("context7");
       if (!apiKey) throw new Error("Context7 API Key not set. Use /set-keys to configure.");

       try {
        const url = new URL(`${API_BASE}/context`);
        url.searchParams.append("libraryId", params.libraryId);
        url.searchParams.append("query", params.query);
        url.searchParams.append("type", params.type || "json");

        const response = await fetch(url.toString(), { headers: headers(), signal });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => null);
          throw new Error(`API Error: ${response.status} ${response.statusText}\n${errorData ? JSON.stringify(errorData) : ''}`);
        }

        const data = await response.json();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          details: data
        };
      } catch (error: any) {
        throw new Error(`Fetch error: ${error.message}`);
      }
    }
  });
  
  // Command moved to brave-search.ts
}
