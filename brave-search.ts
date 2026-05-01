import { Type } from "@sinclair/typebox";
import { type ExtensionAPI, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import fs from "fs";
import path from "path";

// Manage keys in ~/.pi/agent/api-keys.json
const KEYS_FILE = path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent", "api-keys.json");

function loadKeys() {
  try {
    if (fs.existsSync(KEYS_FILE)) {
      return JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8"));
    }
  } catch (e) {
    // Ignore
  }
  return {};
}

function saveKeys(keys: Record<string, string>) {
  try {
    fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), "utf-8");
  } catch (e) {
    // Ignore
  }
}

export function getApiKey(service: "brave" | "context7"): string | undefined {
  const envKey = service === "brave" ? process.env.BRAVE_API_KEY : process.env.CONTEXT7_API_KEY;
  if (envKey) return envKey;
  
  const keys = loadKeys();
  return keys[service];
}

export function setApiKey(service: "brave" | "context7", key: string) {
  const keys = loadKeys();
  keys[service] = key;
  saveKeys(keys);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("set-keys", {
    description: "Set API keys for extensions (Brave, Context7)",
    handler: async (_args, ctx) => {
      const keys = loadKeys();
      
      const braveKey = await ctx.ui.input("Enter Brave Search API Key (leave empty to keep current):", "");
      if (braveKey && braveKey.trim() !== "") {
        keys.brave = braveKey.trim();
      }
      
      const context7Key = await ctx.ui.input("Enter Context7 API Key (leave empty to keep current):", "");
      if (context7Key && context7Key.trim() !== "") {
        keys.context7 = context7Key.trim();
      }
      
      saveKeys(keys);
      ctx.ui.notify("API keys updated and saved.", "info");
    }
  });

  pi.registerTool({
    name: "brave_llm_search",
    label: "Brave LLM Search",
    description: "Web search optimized for AI agents using Brave LLM Context API. Returns pre-extracted text, tables, and code ready for LLM consumption.",
    promptSnippet: "Use brave_llm_search for factual queries or real-time web research.",
    parameters: Type.Object({
      q: Type.String({ description: "Search query" }),
      count: Type.Optional(Type.Integer({ description: "Max search results (1-50, default 20)" })),
      maximum_number_of_tokens: Type.Optional(Type.Integer({ description: "Approx max tokens (1024-32768, default 8192)" })),
      freshness: Type.Optional(Type.String({ description: "Filter by freshness (pd: 24h, pw: 7d, pm: 31d, py: 1y)" })),
      context_threshold_mode: Type.Optional(Type.String({ description: "Relevance threshold: strict, balanced (default), lenient, disabled" })),
    }),
    
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const apiKey = getApiKey("brave");
      if (!apiKey) {
        throw new Error("Brave API Key not set. Use /set-keys to configure.");
      }

      onUpdate?.({
        content: [{ type: "text", text: `Searching Brave for: "${params.q}"...` }],
        details: {}
      });

      const url = new URL("https://api.search.brave.com/res/v1/llm/context");
      url.searchParams.append("q", params.q);
      
      if (params.count) url.searchParams.append("count", params.count.toString());
      if (params.maximum_number_of_tokens) url.searchParams.append("maximum_number_of_tokens", params.maximum_number_of_tokens.toString());
      if (params.freshness) url.searchParams.append("freshness", params.freshness);
      if (params.context_threshold_mode) url.searchParams.append("context_threshold_mode", params.context_threshold_mode);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (!data.grounding?.generic || data.grounding.generic.length === 0) {
         return {
            content: [{ type: "text", text: "No relevant web content found." }],
            details: {}
         };
      }

      let resultText = "";
      for (const item of data.grounding.generic) {
        resultText += `## ${item.title} (${item.url})\n\n`;
        for (const snippet of item.snippets) {
            resultText += `${snippet}\n\n`;
        }
        resultText += `---\n\n`;
      }
      
      const truncation = truncateHead(resultText, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      let contentText = truncation.content;

      if (truncation.truncated) {
        contentText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
        contentText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
      }

      return {
        content: [{ type: "text", text: contentText }],
        details: { resultCount: data.grounding.generic.length }
      };
    },
  });
}