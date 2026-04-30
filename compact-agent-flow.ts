import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	AssistantMessageComponent,
	InteractiveMode,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	isToolCallEventType,
	keyHint,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
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

const toolCache = new Map<string, BuiltInTools>();
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type SharedState = {
	counters: Counters;
	compactMode: boolean;
	toolsExpanded: boolean;
	assistantMessagePatchInstalled: boolean;
	interactiveModePatchInstalled: boolean;
};

const SHARED_STATE_KEY = Symbol.for("pi.compact-agent-flow.state");
const shared = ((globalThis as unknown as Record<symbol, SharedState>)[SHARED_STATE_KEY] ??= {
	counters: createCounters(),
	compactMode: true,
	toolsExpanded: false,
	assistantMessagePatchInstalled: false,
	interactiveModePatchInstalled: false,
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

function shortenPath(path: string | undefined): string {
	if (!path) return "…";
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
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

function compactAssistantContent(content: any): any {
	if (content.type === "thinking") return undefined;
	if (content.type === "text" && typeof content.text === "string") {
		return { ...content, text: content.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() };
	}
	return content;
}

function installUiPatches(): void {
	if (!shared.interactiveModePatchInstalled) {
		shared.interactiveModePatchInstalled = true;
		const prototype = InteractiveMode.prototype as unknown as { setToolsExpanded?: (expanded: boolean) => void };
		const originalSetToolsExpanded = prototype.setToolsExpanded;
		if (typeof originalSetToolsExpanded === "function") {
			prototype.setToolsExpanded = function patchedSetToolsExpanded(this: unknown, expanded: boolean) {
				shared.toolsExpanded = expanded;
				const result = originalSetToolsExpanded.call(this, expanded);
				const mode = this as { chatContainer?: { children?: unknown[] }; streamingComponent?: unknown; streamingMessage?: unknown };
				for (const child of mode.chatContainer?.children ?? []) {
					if (child instanceof AssistantMessageComponent) {
						const message = (child as unknown as { lastMessage?: unknown }).lastMessage;
						if (message) child.updateContent(message as never);
					}
				}
				if (mode.streamingComponent instanceof AssistantMessageComponent && mode.streamingMessage) {
					mode.streamingComponent.updateContent(mode.streamingMessage as never);
				}
				return result;
			};
		}
	}

	if (!shared.assistantMessagePatchInstalled) {
		shared.assistantMessagePatchInstalled = true;
		const prototype = AssistantMessageComponent.prototype as unknown as {
			updateContent: (message: any) => void;
			hideThinkingBlock?: boolean;
		};
		const originalUpdateContent = prototype.updateContent;
		prototype.updateContent = function patchedUpdateContent(this: typeof prototype, message: any) {
			if (shouldHideReasoning()) {
				const result = originalUpdateContent.call(this, {
					...message,
					content: message.content?.map(compactAssistantContent).filter(Boolean) ?? [],
				});
				(this as unknown as { lastMessage?: unknown }).lastMessage = message;
				return result;
			}

			if (shared.compactMode && shared.toolsExpanded) {
				const previousHideThinkingBlock = this.hideThinkingBlock;
				this.hideThinkingBlock = false;
				try {
					return originalUpdateContent.call(this, message);
				} finally {
					this.hideThinkingBlock = previousHideThinkingBlock;
				}
			}

			return originalUpdateContent.call(this, message);
		};
	}
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

function emptyText(): Text {
	return new Text("", 0, 0);
}

function textContent(result: ToolResult): string {
	return result.content.find((content) => content.type === "text")?.text ?? "";
}

function renderExpandableText(result: ToolResult, expanded: boolean, theme: ExtensionContext["ui"]["theme"]): Text {
	if (shared.compactMode && !expanded) return emptyText();
	const text = textContent(result).trim();
	return new Text(text ? `\n${theme.fg("toolOutput", text)}` : "", 0, 0);
}

function registerBuiltInTool(
	pi: ExtensionAPI,
	name: BuiltInToolName,
	definition: ToolDefinition,
	renderCall: (args: any, theme: ExtensionContext["ui"]["theme"]) => string,
): void {
	(pi.registerTool as (tool: any) => void)({
		name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = getBuiltInTools(ctx.cwd)[name] as { execute: (...args: any[]) => Promise<unknown> };
			return tool.execute(toolCallId, params, signal, onUpdate) as never;
		},
		renderCall(args, theme, context) {
			if (shared.compactMode && !context.expanded) return emptyText();
			return new Text(renderCall(args, theme), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			return renderExpandableText(result, expanded, theme);
		},
	});
}

export default function (pi: ExtensionAPI) {
	installUiPatches();

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
		if (event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") shared.counters.searchCalls++;
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

	const cwd = process.cwd();
	registerBuiltInTool(pi, "read", createReadTool(cwd), (args, theme) =>
		`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", shortenPath(args.path))}`,
	);
	registerBuiltInTool(pi, "edit", createEditTool(cwd), (args, theme) =>
		`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", shortenPath(args.path))}`,
	);
	registerBuiltInTool(pi, "write", createWriteTool(cwd), (args, theme) => {
		const lineCount = args.content.split("\n").length;
		return `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", shortenPath(args.path))} ${theme.fg("dim", `(${lineCount} lines)`)}`;
	});
	registerBuiltInTool(pi, "bash", createBashTool(cwd), (args, theme) => {
		const command = args.command.length > 100 ? `${args.command.slice(0, 97)}...` : args.command;
		return `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", command)}`;
	});
	registerBuiltInTool(pi, "grep", createGrepTool(cwd), (args, theme) =>
		`${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", args.pattern)} ${theme.fg("dim", shortenPath(args.path))}`,
	);
	registerBuiltInTool(pi, "find", createFindTool(cwd), (args, theme) =>
		`${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", args.pattern)} ${theme.fg("dim", shortenPath(args.path))}`,
	);
	registerBuiltInTool(pi, "ls", createLsTool(cwd), (args, theme) =>
		`${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", shortenPath(args.path))}`,
	);
}
