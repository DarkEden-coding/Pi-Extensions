import { truncateHead, DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import fs from "fs";
import path from "path";

const KEYS_FILE = path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent", "api-keys.json");
const USER_OUTPUT_MAX_LINES = 4;

type ToolResult = { content?: Array<{ type: string; text?: string }> };

export function loadKeys(): Record<string, string> {
	try {
		if (fs.existsSync(KEYS_FILE)) {
			return JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8"));
		}
	} catch {
		// Ignore malformed or unreadable key files.
	}
	return {};
}

export function saveKeys(keys: Record<string, string>): void {
	try {
		fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
		fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), "utf-8");
	} catch {
		// Ignore key persistence failures.
	}
}

export function getApiKey(service: "brave" | "context7"): string | undefined {
	const envKey = service === "brave" ? process.env.BRAVE_API_KEY : process.env.CONTEXT7_API_KEY;
	if (envKey) return envKey;

	const keys = loadKeys();
	return keys[service];
}

function firstText(result: ToolResult): string {
	return result.content?.find((content) => content.type === "text")?.text ?? "";
}

export function renderTruncatedToolResult(result: ToolResult, { expanded }: { expanded: boolean }, theme: any): Text | undefined {
	if (!expanded) return undefined;

	const text = firstText(result).trim();
	if (!text) return undefined;

	const truncation = truncateHead(text, {
		maxLines: USER_OUTPUT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let output = truncation.content;
	if (truncation.truncated) {
		output += `\n[Output truncated for display: ${truncation.outputLines} of ${truncation.totalLines} lines.]`;
	}

	return new Text(`\n${theme.fg("toolOutput", output)}`, 0, 0);
}
