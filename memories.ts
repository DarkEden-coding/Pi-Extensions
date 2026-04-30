import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { StringEnum } from "@mariozechner/pi-ai";
import { getAgentDir, type ExtensionAPI, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type Scope = "global" | "project";

interface MemoryItem {
	id: number;
	text: string;
	createdAt: string;
	updatedAt: string;
}

interface MemoryStore {
	version: 1;
	nextId: number;
	memories: MemoryItem[];
}

interface MemorySnapshot {
	global: MemoryStore;
	project: MemoryStore;
}

const MEMORY_ACTIONS = ["list", "add", "update", "remove", "clear"] as const;
const MEMORY_SCOPES = ["global", "project"] as const;
const SNAPSHOT_TYPE = "memories-snapshot";
const GLOBAL_FILE = join(getAgentDir(), "memories.json");

const MemoryParams = Type.Object({
	action: StringEnum(MEMORY_ACTIONS),
	scope: StringEnum(MEMORY_SCOPES),
	id: Type.Optional(Type.Number({ description: "Memory id for update/remove" })),
	text: Type.Optional(Type.String({ description: "Memory text" })),
});

function emptyStore(): MemoryStore {
	return { version: 1, nextId: 1, memories: [] };
}

function emptySnapshot(): MemorySnapshot {
	return { global: emptyStore(), project: emptyStore() };
}

function findProjectRoot(startDir: string): string {
	let current = resolve(startDir);

	while (true) {
		if (existsSync(join(current, ".pi"))) return current;
		if (existsSync(join(current, ".git"))) return current;

		const parent = dirname(current);
		if (parent === current) return resolve(startDir);
		current = parent;
	}
}

function getScopeFile(scope: Scope, cwd: string): string {
	if (scope === "global") return GLOBAL_FILE;
	const projectRoot = findProjectRoot(cwd);
	return join(projectRoot, ".pi", "memories.json");
}

async function loadStore(filePath: string): Promise<MemoryStore> {
	try {
		const raw = await readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as Partial<MemoryStore>;
		if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.memories)) return emptyStore();

		return {
			version: 1,
			nextId: typeof parsed.nextId === "number" && parsed.nextId > 0 ? parsed.nextId : 1,
			memories: parsed.memories
				.filter((entry): entry is MemoryItem => !!entry && typeof entry.id === "number" && typeof entry.text === "string")
				.map((entry) => ({
					id: entry.id,
					text: entry.text,
					createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
					updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString(),
				})),
		};
	} catch {
		return emptyStore();
	}
}

async function saveStore(filePath: string, store: MemoryStore): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function mutateStore<T>(filePath: string, mutator: (store: MemoryStore) => Promise<T> | T): Promise<T> {
	return await withFileMutationQueue(filePath, async () => {
		const store = await loadStore(filePath);
		const result = await mutator(store);
		await saveStore(filePath, store);
		return result;
	});
}

async function loadSnapshot(cwd: string): Promise<MemorySnapshot> {
	const projectRoot = findProjectRoot(cwd);
	const [global, project] = await Promise.all([
		loadStore(GLOBAL_FILE),
		loadStore(join(projectRoot, ".pi", "memories.json")),
	]);
	return { global, project };
}

function formatScopeLabel(scope: Scope): string {
	return scope === "global" ? "Global" : "Project";
}

function formatMemoryList(memories: MemoryItem[]): string {
	if (memories.length === 0) return "(none)";
	return memories.map((memory) => `#${memory.id}: ${memory.text}`).join("\n");
}

function makePromptSection(scopeLabel: string, memories: MemoryItem[]): string {
	return memories.length
		? `\n${scopeLabel}:\n${memories.map((memory) => `- [#${memory.id}] ${memory.text}`).join("\n")}`
		: `\n${scopeLabel}: (none)`;
}

function buildMemoryPrompt(snapshot: MemorySnapshot): string | undefined {
	if (snapshot.global.memories.length === 0 && snapshot.project.memories.length === 0) return undefined;

	const sections = [
		makePromptSection("Global memories", snapshot.global.memories),
		makePromptSection("Project memories", snapshot.project.memories),
	].join("\n");

	return `## Saved memories\nThese are durable user instructions and preferences.\nProject memories override global memories when they conflict.\n${sections}\n\nUse the remember tool to add or refine memories when the user gives persistent instructions. Changes made during this chat apply only to new chats, not the current one.`;
}

function normalizeScope(input: string | undefined): Scope | undefined {
	if (!input) return undefined;
	const value = input.trim().toLowerCase();
	if (value === "global" || value === "project") return value;
	return undefined;
}

function parseCommandArgs(args: string): { scope?: Scope; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { rest: "" };

	const [first, ...remaining] = trimmed.split(/\s+/);
	const scope = normalizeScope(first);
	if (scope) return { scope, rest: remaining.join(" ") };
	return { rest: trimmed };
}

async function askForScope(ctx: any): Promise<Scope | undefined> {
	if (!ctx.hasUI) return undefined;
	const choice = await ctx.ui.select("Choose memory scope", ["project", "global"]);
	return normalizeScope(choice ?? undefined);
}

async function askForMemoryText(ctx: any, initialText = ""): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	const value = await ctx.ui.editor("Memory instruction", initialText || "");
	const text = value?.trim();
	return text ? text : undefined;
}

async function askForMemoryId(ctx: any, memories: MemoryItem[]): Promise<number | undefined> {
	if (!ctx.hasUI || memories.length === 0) return undefined;
	const choice = await ctx.ui.select(
		"Choose a memory",
		memories.map((memory) => `#${memory.id}: ${memory.text}`),
	);
	if (!choice) return undefined;
	const match = /^#(\d+)/.exec(choice);
	return match ? Number(match[1]) : undefined;
}

class MemoryBrowser {
	private snapshot: MemorySnapshot = emptySnapshot();
	private activeScope: Scope = "project";
	private selectedByScope: Record<Scope, number> = { global: 0, project: 0 };
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly ctx: any,
		private readonly theme: any,
		private readonly done: () => void,
		private readonly refreshFromDisk: () => Promise<MemorySnapshot>,
	) {}

	setSnapshot(snapshot: MemorySnapshot) {
		this.snapshot = snapshot;
		this.clampSelection();
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private clampSelection() {
		for (const scope of MEMORY_SCOPES) {
			const maxIndex = Math.max(0, this.getStore(scope).memories.length - 1);
			this.selectedByScope[scope] = Math.min(Math.max(0, this.selectedByScope[scope]), maxIndex);
		}
	}

	private getStore(scope: Scope): MemoryStore {
		return scope === "global" ? this.snapshot.global : this.snapshot.project;
	}

	private getSelectedMemory(scope: Scope): MemoryItem | undefined {
		const store = this.getStore(scope);
		if (store.memories.length === 0) return undefined;
		const index = this.selectedByScope[scope] ?? 0;
		return store.memories[Math.min(Math.max(0, index), store.memories.length - 1)];
	}

	private currentMemory(): MemoryItem | undefined {
		return this.getSelectedMemory(this.activeScope);
	}

	private async refresh() {
		this.setSnapshot(await this.refreshFromDisk());
		this.ctx.ui.notify("Memories refreshed", "info");
		this.ctx.ui.setWidget(
			"memories-status",
			[`Saved changes apply to new chats only`, `Active scope: ${formatScopeLabel(this.activeScope)}`],
			{ placement: "belowEditor" },
		);
	}

	private async addMemory() {
		const scope = this.activeScope;
		const text = await askForMemoryText(this.ctx);
		if (!text) return;

		await mutateStore(getScopeFile(scope, this.ctx.cwd), async (store) => {
			const now = new Date().toISOString();
			store.memories.push({ id: store.nextId++, text, createdAt: now, updatedAt: now });
			return undefined;
		});

		await this.refresh();
	}

	private async editCurrentMemory() {
		const scope = this.activeScope;
		const current = this.currentMemory();
		if (!current) {
			this.ctx.ui.notify(`No ${scope} memory selected`, "warning");
			return;
		}

		const text = await askForMemoryText(this.ctx, current.text);
		if (!text) return;

		await mutateStore(getScopeFile(scope, this.ctx.cwd), async (store) => {
			const memory = store.memories.find((entry) => entry.id === current.id);
			if (!memory) return undefined;
			memory.text = text;
			memory.updatedAt = new Date().toISOString();
			return undefined;
		});

		await this.refresh();
	}

	private async deleteCurrentMemory() {
		const scope = this.activeScope;
		const current = this.currentMemory();
		if (!current) {
			this.ctx.ui.notify(`No ${scope} memory selected`, "warning");
			return;
		}

		const confirmed = await this.ctx.ui.confirm(
			`Delete ${scope} memory #${current.id}?`,
			"This only affects future chats; the current chat keeps its snapshot.",
		);
		if (!confirmed) return;

		await mutateStore(getScopeFile(scope, this.ctx.cwd), async (store) => {
			const index = store.memories.findIndex((entry) => entry.id === current.id);
			if (index >= 0) store.memories.splice(index, 1);
			return undefined;
		});

		await this.refresh();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.activeScope = this.activeScope === "project" ? "global" : "project";
			this.cachedWidth = undefined;
			this.cachedLines = undefined;
			this.ctx.ui.setWidget(
				"memories-status",
				[`Saved changes apply to new chats only`, `Active scope: ${formatScopeLabel(this.activeScope)}`],
				{ placement: "belowEditor" },
			);
			this.ctx.ui.notify(`Viewing ${this.activeScope} memories`, "info");
			return;
		}

		if (matchesKey(data, "up")) {
			const store = this.getStore(this.activeScope);
			if (store.memories.length > 0) {
				this.selectedByScope[this.activeScope] = Math.max(0, this.selectedByScope[this.activeScope] - 1);
				this.cachedWidth = undefined;
				this.cachedLines = undefined;
			}
			return;
		}

		if (matchesKey(data, "down")) {
			const store = this.getStore(this.activeScope);
			if (store.memories.length > 0) {
				this.selectedByScope[this.activeScope] = Math.min(
					Math.max(0, store.memories.length - 1),
					this.selectedByScope[this.activeScope] + 1,
				);
				this.cachedWidth = undefined;
				this.cachedLines = undefined;
			}
			return;
		}

		if (data === "a") {
			void this.addMemory();
			return;
		}

		if (data === "e") {
			void this.editCurrentMemory();
			return;
		}

		if (data === "d") {
			void this.deleteCurrentMemory();
			return;
		}

		if (data === "r") {
			void this.refresh();
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const header = this.theme.fg("accent", " Memories ") + this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 11)));
		lines.push(truncateToWidth(header, width));
		lines.push(truncateToWidth(this.theme.fg("muted", "Tab switches scope • a add • e edit • d delete • r refresh • Esc close"), width));
		lines.push(truncateToWidth(this.theme.fg("warning", "Edits are saved now but only affect new chats, not the current one."), width));
		lines.push("");

		for (const scope of MEMORY_SCOPES) {
			const store = this.getStore(scope);
			const active = scope === this.activeScope;
			lines.push(
				truncateToWidth(
					`${active ? this.theme.fg("accent", ">") : " "} ${formatScopeLabel(scope)} (${store.memories.length})`,
					width,
				),
			);
			if (store.memories.length === 0) {
				lines.push(truncateToWidth(`  ${this.theme.fg("dim", "(none)")}`, width));
			} else {
				const selected = this.selectedByScope[scope] ?? 0;
				const items = store.memories;
				const maxItems = 8;
				const start = Math.max(0, Math.min(selected - Math.floor(maxItems / 2), Math.max(0, items.length - maxItems)));
				const visible = items.slice(start, start + maxItems);
				for (let i = 0; i < visible.length; i++) {
					const memory = visible[i]!;
					const isSelected = start + i === selected && active;
					const prefix = isSelected ? this.theme.fg("accent", ">") : " ";
					const label = `  ${prefix} #${memory.id} ${memory.text}`;
					lines.push(truncateToWidth(isSelected ? this.theme.fg("accent", label) : label, width));
				}
				if (items.length > visible.length) {
					lines.push(truncateToWidth(`  ${this.theme.fg("dim", `… ${items.length - visible.length} more`)}`, width));
				}
			}
			lines.push("");
		}

		const current = this.currentMemory();
		lines.push(truncateToWidth(this.theme.fg("muted", "Selected memory preview:"), width));
		lines.push(
			truncateToWidth(
				current ? current.text : this.theme.fg("dim", "(no memory selected)"),
				width,
			),
		);

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function memoriesExtension(pi: ExtensionAPI) {
	let activeSnapshot: MemorySnapshot = emptySnapshot();

	pi.on("session_start", async (event, ctx) => {
		// /reload and /new should always re-read the memory files from disk so any
		// cached snapshot reflects the latest saved memories instead of reusing the
		// previous session's in-memory state.
		if (event.reason === "reload" || event.reason === "new") {
			activeSnapshot = emptySnapshot();
		}

		activeSnapshot = await loadSnapshot(ctx.cwd);
		pi.appendEntry(SNAPSHOT_TYPE, activeSnapshot);
	});

	pi.on("before_agent_start", async (event) => {
		const prompt = buildMemoryPrompt(activeSnapshot);
		if (!prompt) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});

	pi.registerTool({
		name: "remember",
		label: "Remember",
		description: "Store durable user instructions or preferences in global or project scope.",
		promptSnippet: "Persist durable user preferences or project instructions in global or project scope.",
		promptGuidelines: [
			"Use this tool for durable user preferences, project instructions, and repeated workflow constraints.",
			"Prefer project scope for repo-specific instructions and global scope for personal preferences.",
			"If the instruction is ambiguous or incomplete, ask a follow-up question before storing it.",
			"When editing a memory, remember the change only affects new chats; the current chat keeps its cached snapshot.",
		],
		parameters: MemoryParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope as Scope;
			const filePath = getScopeFile(scope, ctx.cwd);

			if (params.action === "list") {
				const store = await loadStore(filePath);
				return {
					content: [{ type: "text", text: `${formatScopeLabel(scope)} memories\n${formatMemoryList(store.memories)}` }],
					details: { scope, memories: store.memories },
				};
			}

			if (params.action === "clear") {
				if (!ctx.hasUI) {
					return {
						content: [{ type: "text", text: `Error: UI required to confirm clearing ${scope} memories.` }],
						details: { scope, error: true },
					};
				}

				const confirmed = await ctx.ui.confirm(
					`Clear ${scope} memories?`,
					"This will delete all saved instructions in that scope. The current chat will still use its cached snapshot.",
				);
				if (!confirmed) {
					return { content: [{ type: "text", text: "Cancelled" }], details: { scope, cancelled: true } };
				}

				return await mutateStore(filePath, async (store) => {
					const count = store.memories.length;
					store.memories = [];
					store.nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} ${scope} memory${count === 1 ? "" : "s"}` }],
						details: { scope, cleared: count },
					};
				});
			}

			if (params.action === "add") {
				let text = params.text?.trim();
				if (!text && ctx.hasUI) text = await askForMemoryText(ctx);
				if (!text) {
					return { content: [{ type: "text", text: "Error: memory text is required." }], details: { scope, error: true } };
				}

				return await mutateStore(filePath, async (store) => {
					const now = new Date().toISOString();
					const item: MemoryItem = { id: store.nextId++, text, createdAt: now, updatedAt: now };
					store.memories.push(item);
					return {
						content: [{ type: "text", text: `Saved ${scope} memory #${item.id}. It will affect new chats only.` }],
						details: { scope, memory: item, memories: store.memories },
					};
				});
			}

			if (params.action === "update") {
				return await mutateStore(filePath, async (store) => {
					let id = params.id;
					if (id === undefined && ctx.hasUI) id = await askForMemoryId(ctx, store.memories);
					if (id === undefined) {
						return { content: [{ type: "text", text: "Error: memory id is required for update." }], details: { scope, error: true } };
					}

					const memory = store.memories.find((entry) => entry.id === id);
					if (!memory) {
						return { content: [{ type: "text", text: `Error: memory #${id} not found.` }], details: { scope, error: true } };
					}

					let text = params.text?.trim();
					if (!text && ctx.hasUI) text = await askForMemoryText(ctx, memory.text);
					if (!text) {
						return {
							content: [{ type: "text", text: "Error: memory text is required for update." }],
							details: { scope, error: true },
						};
					}

					memory.text = text;
					memory.updatedAt = new Date().toISOString();
					return {
						content: [{ type: "text", text: `Updated ${scope} memory #${memory.id}. It will affect new chats only.` }],
						details: { scope, memory, memories: store.memories },
					};
				});
			}

			if (params.action === "remove") {
				return await mutateStore(filePath, async (store) => {
					let id = params.id;
					if (id === undefined && ctx.hasUI) id = await askForMemoryId(ctx, store.memories);
					if (id === undefined) {
						return { content: [{ type: "text", text: "Error: memory id is required for remove." }], details: { scope, error: true } };
					}

					const index = store.memories.findIndex((entry) => entry.id === id);
					if (index === -1) {
						return { content: [{ type: "text", text: `Error: memory #${id} not found.` }], details: { scope, error: true } };
					}

					const [removed] = store.memories.splice(index, 1);
					return {
						content: [{ type: "text", text: `Removed ${scope} memory #${removed.id}. It will affect new chats only.` }],
						details: { scope, removed, memories: store.memories },
					};
				});
			}

			return {
				content: [{ type: "text", text: `Error: unsupported action ${params.action}` }],
				details: { scope, error: true },
			};
		},
	});

	pi.registerCommand("memories", {
		description: "Open the memories viewer (usage: /memories [all|global|project])",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				const raw = args.trim().toLowerCase();
				const scopes: Scope[] = raw === "global" || raw === "project" ? [raw] : ["global", "project"];
				const snapshot = await loadSnapshot(ctx.cwd);
				const lines = ["Memories", "", `Project root: ${findProjectRoot(ctx.cwd)}`, ""];
				for (const scope of scopes) {
					const store = scope === "global" ? snapshot.global : snapshot.project;
					lines.push(`${formatScopeLabel(scope)} (${store.memories.length})`);
					lines.push(formatMemoryList(store.memories));
					lines.push("");
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const component = new MemoryBrowser(
					ctx,
					theme,
					() => {
						ctx.ui.setWidget("memories-status", [], { placement: "belowEditor" });
						done();
					},
					async () => loadSnapshot(ctx.cwd),
				);

				component.setSnapshot(activeSnapshot);
				ctx.ui.setWidget("memories-status", ["Saved changes apply to new chats only", `Active scope: Project / Global (Tab)`], {
					placement: "belowEditor",
				});

				return {
					render: (width) => component.render(width),
					handleInput: (data) => component.handleInput(data),
					invalidate: () => {
						// no-op; component manages its own cache
					},
				};
			});
		},
	});

	pi.registerCommand("remember", {
		description: "Add a memory (usage: /remember [global|project] <text>)",
		handler: async (args, ctx) => {
			let { scope, rest } = parseCommandArgs(args);
			if (!scope) scope = await askForScope(ctx);
			if (!scope) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			let text = rest.trim();
			if (!text && ctx.hasUI) text = (await askForMemoryText(ctx)) ?? "";
			if (!text) {
				ctx.ui.notify("Memory text is required", "error");
				return;
			}

			const filePath = getScopeFile(scope, ctx.cwd);
			const result = await mutateStore(filePath, async (store) => {
				const now = new Date().toISOString();
				const memory: MemoryItem = { id: store.nextId++, text, createdAt: now, updatedAt: now };
				store.memories.push(memory);
				return memory;
			});

			ctx.ui.notify(`Saved ${scope} memory #${result.id}. It will affect new chats only.`, "info");
		},
	});

	pi.registerCommand("forget", {
		description: "Remove a memory (usage: /forget [global|project] <id>)",
		handler: async (args, ctx) => {
			let { scope, rest } = parseCommandArgs(args);
			if (!scope) scope = await askForScope(ctx);
			if (!scope) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const filePath = getScopeFile(scope, ctx.cwd);
			const store = await loadStore(filePath);
			let id = Number(rest.trim());
			if ((!Number.isFinite(id) || id <= 0) && ctx.hasUI) id = (await askForMemoryId(ctx, store.memories)) ?? NaN;
			if (!Number.isFinite(id) || id <= 0) {
				ctx.ui.notify("Memory id is required", "error");
				return;
			}

			const result = await mutateStore(filePath, async (current) => {
				const index = current.memories.findIndex((entry) => entry.id === id);
				if (index === -1) return undefined;
				const [removed] = current.memories.splice(index, 1);
				return removed;
			});

			if (!result) {
				ctx.ui.notify(`Memory #${id} not found`, "warning");
				return;
			}

			ctx.ui.notify(`Removed ${scope} memory #${id}. It will affect new chats only.`, "info");
		},
	});
}
