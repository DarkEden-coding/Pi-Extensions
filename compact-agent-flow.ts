import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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

type BuiltInTools = ReturnType<typeof createBuiltInTools>;

const toolCache = new Map<string, BuiltInTools>();
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let counters: Counters = createCounters();
let compactMode = true;

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
		`${counters.toolsCalled} tools`,
		`${counters.filesRead.size} files read`,
		`${counters.filesEdited.size} files edited`,
		`+${counters.linesAdded}/-${counters.linesRemoved}`,
	];
	if (counters.bashCalls > 0) parts.push(`${counters.bashCalls} shell`);
	if (counters.searchCalls > 0) parts.push(`${counters.searchCalls} search`);
	return parts.join(" · ");
}

function updateWorkingUi(ctx: ExtensionContext): void {
	const hint = keyHint("app.tools.expand", "expand");
	ctx.ui.setWorkingMessage(`${compactSummary()} ${ctx.ui.theme.fg("dim", `(${hint})`)}`);
	ctx.ui.setStatus("compact-agent-flow", ctx.ui.theme.fg("dim", `${compactSummary()} (${hint})`));
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

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((content) => content.type === "text")?.text ?? "";
}

function renderExpandableText(
	result: { content: Array<{ type: string; text?: string }> },
	expanded: boolean,
	theme: ExtensionContext["ui"]["theme"],
): Text {
	if (compactMode && !expanded) return emptyText();
	const text = textContent(result).trim();
	return new Text(text ? `\n${theme.fg("toolOutput", text)}` : "", 0, 0);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setWorkingIndicator({
			frames: SPINNER_FRAMES.map((frame) => ctx.ui.theme.fg("accent", frame)),
			intervalMs: 80,
		});
		ctx.ui.setToolsExpanded(!compactMode);
		ctx.ui.setStatus("compact-agent-flow", ctx.ui.theme.fg("dim", compactMode ? "Compact agent flow on" : "Compact agent flow off"));
	});

	pi.on("agent_start", async (_event, ctx) => {
		counters = createCounters();
		if (compactMode) ctx.ui.setToolsExpanded(false);
		updateWorkingUi(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		ctx.ui.setWorkingMessage();
		ctx.ui.setStatus("compact-agent-flow", ctx.ui.theme.fg("dim", `last: ${compactSummary()}`));
	});

	pi.on("tool_call", async (event, ctx) => {
		counters.toolsCalled++;
		if (isToolCallEventType("read", event)) counters.filesRead.add(event.input.path);
		if (isToolCallEventType("edit", event)) counters.filesEdited.add(event.input.path);
		if (isToolCallEventType("write", event)) {
			counters.filesEdited.add(event.input.path);
			counters.linesAdded += event.input.content.split("\n").length;
		}
		if (isToolCallEventType("bash", event)) counters.bashCalls++;
		if (event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") counters.searchCalls++;
		updateWorkingUi(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "edit") {
			const details = event.details as { diff?: string } | undefined;
			const diffCounts = countDiffLines(details?.diff);
			counters.linesAdded += diffCounts.added;
			counters.linesRemoved += diffCounts.removed;
			updateWorkingUi(ctx);
		}
	});

	pi.registerCommand("compact-flow", {
		description: "Toggle compact agent output flow.",
		handler: async (_args, ctx) => {
			compactMode = !compactMode;
			ctx.ui.setToolsExpanded(!compactMode);
			ctx.ui.notify(`Compact agent flow ${compactMode ? "enabled" : "disabled"}`, "info");
			updateWorkingUi(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+o", {
		description: "Toggle compact agent output flow",
		handler: async (ctx) => {
			compactMode = !compactMode;
			ctx.ui.setToolsExpanded(!compactMode);
			ctx.ui.notify(`Compact agent flow ${compactMode ? "enabled" : "disabled"}`, "info");
		},
	});

	const cwd = process.cwd();
	const read = createReadTool(cwd);
	pi.registerTool({
		name: "read",
		label: read.label,
		description: read.description,
		parameters: read.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			if (compactMode && !context.expanded) return emptyText();
			return new Text(`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", shortenPath(args.path))}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			return renderExpandableText(result, expanded, theme);
		},
	});

	const edit = createEditTool(cwd);
	pi.registerTool({
		name: "edit",
		label: edit.label,
		description: edit.description,
		parameters: edit.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			if (compactMode && !context.expanded) return emptyText();
			return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", shortenPath(args.path))}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			return renderExpandableText(result, expanded, theme);
		},
	});

	const write = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: write.label,
		description: write.description,
		parameters: write.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			if (compactMode && !context.expanded) return emptyText();
			const lineCount = args.content.split("\n").length;
			return new Text(`${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", shortenPath(args.path))} ${theme.fg("dim", `(${lineCount} lines)`)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			return renderExpandableText(result, expanded, theme);
		},
	});

	const bash = createBashTool(cwd);
	pi.registerTool({
		name: "bash",
		label: bash.label,
		description: bash.description,
		parameters: bash.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			if (compactMode && !context.expanded) return emptyText();
			const command = args.command.length > 100 ? `${args.command.slice(0, 97)}...` : args.command;
			return new Text(`${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", command)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			return renderExpandableText(result, expanded, theme);
		},
	});

	const grep = createGrepTool(cwd);
	pi.registerTool({
		name: "grep",
		label: grep.label,
		description: grep.description,
		parameters: grep.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			if (compactMode && !context.expanded) return emptyText();
			return new Text(`${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", args.pattern)} ${theme.fg("dim", shortenPath(args.path))}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			return renderExpandableText(result, expanded, theme);
		},
	});

	const find = createFindTool(cwd);
	pi.registerTool({
		name: "find",
		label: find.label,
		description: find.description,
		parameters: find.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			if (compactMode && !context.expanded) return emptyText();
			return new Text(`${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", args.pattern)} ${theme.fg("dim", shortenPath(args.path))}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			return renderExpandableText(result, expanded, theme);
		},
	});

	const ls = createLsTool(cwd);
	pi.registerTool({
		name: "ls",
		label: ls.label,
		description: ls.description,
		parameters: ls.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			if (compactMode && !context.expanded) return emptyText();
			return new Text(`${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", shortenPath(args.path))}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			return renderExpandableText(result, expanded, theme);
		},
	});
}
