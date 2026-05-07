import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	isToolCallEventType,
	keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

type Counters = {
	toolsCalled: number;
	filesRead: Set<string>;
	filesEdited: Set<string>;
	bashCalls: number;
	searchCalls: number;
	linesAdded: number;
	linesRemoved: number;
};

type ToolResult = { content: Array<{ type: string; text?: string }> };
type BuiltInTools = ReturnType<typeof createBuiltInTools>;
type BuiltInToolName = keyof BuiltInTools;
type ToolDefinition = {
	label: string;
	description: string;
	parameters: unknown;
};
type AssistantContent = {
	type: string;
	text?: string;
	textSignature?: string;
};
type AssistantMessageLike = {
	role: string;
	content?: AssistantContent[];
};

const toolCache = new Map<string, BuiltInTools>();
const TOOL_DEFINITIONS: Record<BuiltInToolName, ToolDefinition> = {
	read: {
		label: "read",
		description: "Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
		parameters: {
			type: "object",
			required: ["path"],
			properties: {
				path: { type: "string", description: "Path to the file to read (relative or absolute)" },
				offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
				limit: { type: "number", description: "Maximum number of lines to read" },
			},
		},
	},
	edit: {
		label: "edit",
		description: "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		parameters: {
			type: "object",
			required: ["path", "edits"],
			properties: {
				path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
				edits: {
					type: "array",
					description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
					items: {
						type: "object",
						required: ["oldText", "newText"],
						properties: {
							oldText: { type: "string", description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call." },
							newText: { type: "string", description: "Replacement text for this targeted edit." },
						},
						additionalProperties: false,
					},
				},
			},
			additionalProperties: false,
		},
	},
	write: {
		label: "write",
		description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: { type: "object", required: ["path", "content"], properties: { path: { type: "string", description: "Path to the file to write (relative or absolute)" }, content: { type: "string", description: "Content to write to the file" } } },
	},
	bash: {
		label: "bash",
		description: "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
		parameters: { type: "object", required: ["command"], properties: { command: { type: "string", description: "Bash command to execute" }, timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" } } },
	},
	grep: {
		label: "grep",
		description: "Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.",
		parameters: { type: "object", required: ["pattern"], properties: { pattern: { type: "string", description: "Search pattern (regex or literal string)" }, path: { type: "string", description: "Directory or file to search (default: current directory)" }, glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" }, ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" }, literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" }, context: { type: "number", description: "Number of lines to show before and after each match (default: 0)" }, limit: { type: "number", description: "Maximum number of matches to return (default: 100)" } } },
	},
	find: {
		label: "find",
		description: "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).",
		parameters: { type: "object", required: ["pattern"], properties: { pattern: { type: "string", description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }, path: { type: "string", description: "Directory to search in (default: current directory)" }, limit: { type: "number", description: "Maximum number of results (default: 1000)" } } },
	},
	ls: {
		label: "ls",
		description: "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).",
		parameters: { type: "object", properties: { path: { type: "string", description: "Directory to list (default: current directory)" }, limit: { type: "number", description: "Maximum number of entries to return (default: 500)" } } },
	},
};
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type SharedState = {
	counters: Counters;
	compactMode: boolean;
	toolsExpanded: boolean;
};

const SHARED_STATE_KEY = Symbol.for("pi.compact-agent-flow.state");
const shared = ((globalThis as unknown as Record<symbol, SharedState>)[SHARED_STATE_KEY] ??= {
	counters: createCounters(),
	compactMode: true,
	toolsExpanded: false,
});

function createCounters(): Counters {
	return {
		toolsCalled: 0,
		filesRead: new Set<string>(),
		filesEdited: new Set<string>(),
		bashCalls: 0,
		searchCalls: 0,
		linesAdded: 0,
		linesRemoved: 0,
	};
}

function createBuiltInTools(cwd: string) {
	return {
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
		read: createReadTool(cwd),
		write: createWriteTool(cwd),
	};
}

function getBuiltInTools(cwd: string): BuiltInTools {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function shortenPath(path: unknown): string {
	const text = str(path);
	if (!text) return "…";
	const home = homedir();
	return text.startsWith(home) ? `~${text.slice(home.length)}` : text;
}

function compactSummary(): string {
	const parts = [
		"agent working",
		`${shared.counters.toolsCalled} tools`,
		`${shared.counters.filesRead.size} files read`,
		`${shared.counters.filesEdited.size} files edited`,
		`+${shared.counters.linesAdded}/-${shared.counters.linesRemoved}`,
	];
	if (shared.counters.bashCalls > 0) parts.push(`${shared.counters.bashCalls} shell`);
	if (shared.counters.searchCalls > 0) parts.push(`${shared.counters.searchCalls} search`);
	return parts.join(" · ");
}

function updateWorkingUi(ctx: ExtensionContext): void {
	const hint = keyHint("app.tools.expand", shared.toolsExpanded ? "collapse" : "expand");
	const summary = compactSummary();
	ctx.ui.setWorkingMessage(`${summary} ${ctx.ui.theme.fg("dim", `(${hint})`)}`);
	ctx.ui.setStatus("compact-agent-flow", ctx.ui.theme.fg("dim", `${summary} (${hint})`));
}

function setCompactMode(ctx: ExtensionContext, enabled: boolean): void {
	shared.compactMode = enabled;
	shared.toolsExpanded = !enabled;
	ctx.ui.setToolsExpanded(shared.toolsExpanded);
	ctx.ui.setHiddenThinkingLabel(enabled ? "" : undefined);
}

function toggleCompactMode(ctx: ExtensionContext): void {
	setCompactMode(ctx, !shared.compactMode);
	ctx.ui.notify(`Compact agent flow ${shared.compactMode ? "enabled" : "disabled"}`, "info");
	updateWorkingUi(ctx);
}

function shouldHideReasoning(): boolean {
	return shared.compactMode && !shared.toolsExpanded;
}

function textSignaturePhase(signature: string | undefined): "commentary" | "final_answer" | undefined {
	if (!signature?.startsWith("{")) return undefined;
	try {
		const parsed = JSON.parse(signature) as { phase?: unknown };
		return parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined;
	} catch {
		return undefined;
	}
}

function stripReasoningText(text: string): string {
	return text
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
		.trim();
}

function compactAssistantContent(content: AssistantContent): AssistantContent | undefined {
	if (content.type === "thinking" || content.type === "reasoning") return undefined;
	if (content.type === "text" && typeof content.text === "string") {
		if (textSignaturePhase(content.textSignature) === "commentary") return undefined;
		const text = stripReasoningText(content.text);
		return text ? { ...content, text } : undefined;
	}
	return content;
}

function compactAssistantMessage<T extends AssistantMessageLike>(message: T): T {
	if (!shouldHideReasoning() || message.role !== "assistant") return message;
	return {
		...message,
		content: message.content?.map(compactAssistantContent).filter((content) => content !== undefined) ?? [],
	};
}

function countDiffLines(diff: string | undefined): { added: number; removed: number } {
	if (!diff) return { added: 0, removed: 0 };
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

function textContent(result: ToolResult): string {
	return result.content.find((content) => content.type === "text")?.text ?? "";
}

function renderExpandableText(result: ToolResult, expanded: boolean, theme: ExtensionContext["ui"]["theme"]): Text | undefined {
	if (shared.compactMode && !expanded) return undefined;
	const text = textContent(result).trim();
	return text ? new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0) : undefined;
}

function registerBuiltInTool(
	pi: ExtensionAPI,
	name: BuiltInToolName,
	definition: ToolDefinition,
	renderCall: (args: Record<string, unknown>, theme: ExtensionContext["ui"]["theme"]) => string,
): void {
	(pi.registerTool as (tool: unknown) => void)({
		name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = getBuiltInTools(ctx.cwd)[name] as { execute: (...args: unknown[]) => Promise<unknown> };
			return tool.execute(toolCallId, params, signal, onUpdate) as never;
		},
		renderCall(args, theme, context) {
			if (shared.compactMode && !context.expanded) return undefined;
			return new Text(renderCall(args, theme), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			return renderExpandableText(result, expanded, theme);
		},
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWorkingIndicator({
			frames: SPINNER_FRAMES.map((frame) => ctx.ui.theme.fg("accent", frame)),
			intervalMs: 80,
		});
		setCompactMode(ctx, shared.compactMode);
		ctx.ui.setStatus("compact-agent-flow", ctx.ui.theme.fg("dim", shared.compactMode ? "Compact agent flow on" : "Compact agent flow off"));
	});

	pi.on("agent_start", async (_event, ctx) => {
		shared.counters = createCounters();
		setCompactMode(ctx, shared.compactMode);
		updateWorkingUi(ctx);
	});

	pi.on("message_update", async (event) => ({ message: compactAssistantMessage(event.message) }));
	pi.on("message_end", async (event) => ({ message: compactAssistantMessage(event.message) }));

	pi.on("agent_end", async (_event, ctx) => {
		ctx.ui.setWorkingMessage();
		ctx.ui.setStatus("compact-agent-flow", ctx.ui.theme.fg("dim", `last: ${compactSummary()}`));
	});

	pi.on("tool_call", async (event, ctx) => {
		shared.counters.toolsCalled++;
		if (isToolCallEventType("read", event)) shared.counters.filesRead.add(event.input.path);
		if (isToolCallEventType("edit", event)) shared.counters.filesEdited.add(event.input.path);
		if (isToolCallEventType("write", event)) {
			shared.counters.filesEdited.add(event.input.path);
			shared.counters.linesAdded += event.input.content.split("\n").length;
		}
		if (isToolCallEventType("bash", event)) shared.counters.bashCalls++;
		if (
			event.toolName === "grep" ||
			event.toolName === "find" ||
			event.toolName === "ls" ||
			event.toolName === "brave_llm_search" ||
			event.toolName === "context7_search_library" ||
			event.toolName === "context7_get_context"
		)
			shared.counters.searchCalls++;
		updateWorkingUi(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "edit") {
			const details = event.details as { diff?: string } | undefined;
			const diffCounts = countDiffLines(details?.diff);
			shared.counters.linesAdded += diffCounts.added;
			shared.counters.linesRemoved += diffCounts.removed;
			updateWorkingUi(ctx);
		}
	});

	pi.registerCommand("compact-flow", {
		description: "Toggle compact agent output flow.",
		handler: async (_args, ctx) => toggleCompactMode(ctx),
	});

	pi.registerShortcut("ctrl+shift+o", {
		description: "Toggle compact agent output flow",
		handler: async (ctx) => toggleCompactMode(ctx),
	});

	registerBuiltInTool(pi, "read", TOOL_DEFINITIONS.read, (args, theme) =>
		`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", shortenPath(args.path))}`,
	);
	registerBuiltInTool(pi, "edit", TOOL_DEFINITIONS.edit, (args, theme) =>
		`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", shortenPath(args.path))}`,
	);
	registerBuiltInTool(pi, "write", TOOL_DEFINITIONS.write, (args, theme) => {
		const content = str(args.content);
		const lineCount = content.split("\n").length;
		return `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", shortenPath(args.path))} ${theme.fg("dim", `(${lineCount} lines)`)}`;
	});
	registerBuiltInTool(pi, "bash", TOOL_DEFINITIONS.bash, (args, theme) => {
		const rawCommand = str(args.command);
		const command = rawCommand.length > 100 ? `${rawCommand.slice(0, 97)}...` : rawCommand;
		return `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", command)}`;
	});
	registerBuiltInTool(pi, "grep", TOOL_DEFINITIONS.grep, (args, theme) =>
		`${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", str(args.pattern))} ${theme.fg("dim", shortenPath(args.path))}`,
	);
	registerBuiltInTool(pi, "find", TOOL_DEFINITIONS.find, (args, theme) =>
		`${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", str(args.pattern))} ${theme.fg("dim", shortenPath(args.path))}`,
	);
	registerBuiltInTool(pi, "ls", TOOL_DEFINITIONS.ls, (args, theme) =>
		`${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", shortenPath(args.path))}`,
	);
}
