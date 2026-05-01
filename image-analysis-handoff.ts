import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Input, Key, matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

type InputAbility = "text" | "image";
type ModelLike = {
	provider: string;
	id: string;
	name?: string;
	api: string;
	input?: InputAbility[];
};

type StoredChoice = { provider: string; id: string };
type MessageContent = { type: string; text?: string };

const CUSTOM_TYPE = "image-analysis-handoff";

function modelKey(model: ModelLike) {
	return `${model.provider}/${model.id}`;
}

function supportsImages(model: ModelLike) {
	return Array.isArray(model.input) && model.input.includes("image");
}

function searchableText(model: ModelLike) {
	return `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase();
}

class ModelSearchPicker implements Component, Focusable {
	private input = new Input();
	private filtered: ModelLike[];
	private selected = 0;
	private container = new Container();
	private _focused = false;

	constructor(
		private models: ModelLike[],
		private theme: any,
		private requestRender: () => void,
		private done: (model: ModelLike | null) => void,
	) {
		this.filtered = models;
	}

	get focused() {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			if (this.filtered.length > 0) this.selected = this.selected === 0 ? this.filtered.length - 1 : this.selected - 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.filtered.length > 0) this.selected = this.selected === this.filtered.length - 1 ? 0 : this.selected + 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const model = this.filtered[this.selected];
			if (model) this.done(model);
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(null);
			return;
		}

		this.input.handleInput(data);
		this.applyFilter();
		this.requestRender();
	}

	render(width: number): string[] {
		this.container = new Container();
		this.container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
		this.container.addChild({
			render: (w: number) => [this.theme.fg("accent", this.theme.bold("Search available models")), ...this.input.render(w)],
			invalidate: () => this.input.invalidate(),
		});
		this.container.addChild({ render: (w: number) => this.renderList(w), invalidate: () => {} });
		this.container.addChild({
			render: (w: number) => [truncateToWidth(this.theme.fg("dim", "↑↓ navigate • type to filter • enter select • esc cancel"), w)],
			invalidate: () => {},
		});
		this.container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
		return this.container.render(width);
	}

	invalidate(): void {
		this.container.invalidate();
		this.input.invalidate();
	}

	private applyFilter() {
		const query = this.input.getValue().trim().toLowerCase();
		this.filtered = query ? this.models.filter((m) => searchableText(m).includes(query)) : this.models;
		this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
	}

	private renderList(width: number): string[] {
		if (this.filtered.length === 0) return [this.theme.fg("warning", "  No matching models")];
		const visible = 12;
		const start = Math.max(0, Math.min(this.selected - Math.floor(visible / 2), this.filtered.length - visible));
		const end = Math.min(start + visible, this.filtered.length);
		const lines: string[] = [];
		for (let i = start; i < end; i++) {
			const model = this.filtered[i]!;
			const isSelected = i === this.selected;
			const label = `${modelKey(model)} ${supportsImages(model) ? "[image]" : "[text-only]"}${model.name ? ` — ${model.name}` : ""}`;
			const line = truncateToWidth(`${isSelected ? "→" : " "} ${label}`, width);
			lines.push(isSelected ? this.theme.bg("selectedBg", this.theme.fg("accent", line)) : line);
		}
		if (this.filtered.length > visible) lines.push(this.theme.fg("dim", `  (${this.selected + 1}/${this.filtered.length})`));
		return lines;
	}
}

export default function imageAnalysisHandoff(pi: ExtensionAPI) {
	let selected: StoredChoice | undefined;

	pi.on("session_start", (_event, ctx) => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const choice = entry.data as StoredChoice | undefined;
				if (choice?.provider && choice?.id) selected = choice;
			}
		}
	});

	pi.registerCommand("image-analysis-model", {
		description: "Search all available models and select the vision model used to analyze attached images",
		handler: async (_args, ctx) => {
			const allModels = ctx.modelRegistry.getAvailable() as ModelLike[];
			if (allModels.length === 0) {
				ctx.ui.notify("No authenticated models found.", "warning");
				return;
			}

			const model = await ctx.ui.custom<ModelLike | null>(
				(tui, theme, _keybindings, done) => new ModelSearchPicker(allModels, theme, () => tui.requestRender(), done),
				{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } },
			);
			if (!model) return;

			if (!supportsImages(model)) {
				ctx.ui.notify(`${modelKey(model)} is text-only and cannot analyze images. Choose a model marked [image].`, "warning");
				return;
			}

			selected = { provider: model.provider, id: model.id };
			pi.appendEntry(CUSTOM_TYPE, selected);
			ctx.ui.notify(`Image analysis model set to ${modelKey(model)}`, "success");
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!event.images?.length) return;

		let model: ModelLike | undefined;
		if (selected) model = ctx.modelRegistry.find(selected.provider, selected.id) as ModelLike | undefined;

		if (!model) {
			ctx.ui.notify("Attached images were not pre-analyzed: no image analysis model selected. Run /image-analysis-model.", "warning");
			return;
		}
		if (!supportsImages(model)) {
			ctx.ui.notify(`Selected image analysis model ${modelKey(model)} cannot accept images. Run /image-analysis-model.`, "warning");
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as never);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify(`Image analysis auth failed for ${modelKey(model)}: ${auth.ok ? "missing API key" : auth.error}`, "warning");
			return;
		}

		ctx.ui.setStatus("image-analysis", `Analyzing ${event.images.length} image(s) with ${modelKey(model)}...`);
		try {
			const { complete } = await import("@mariozechner/pi-ai");
			const response = await complete(model as never, {
				messages: [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: `Analyze all attached images for the next coding-agent model. Use the user's prompt as context so you extract only relevant visual details.\n\nUser prompt:\n${event.prompt}\n\nReturn concise markdown with: visible text, UI/code/diagram details, relationships between images, and any uncertainties.`,
							},
							...event.images,
						],
						timestamp: Date.now(),
					},
				],
			}, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 2048, signal: ctx.signal });

			const analysis = response.content
				.filter((c: MessageContent): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
				.map((c: { text: string }) => c.text)
				.join("\n")
				.trim();

			if (!analysis) return;
			return {
				message: {
					customType: CUSTOM_TYPE,
					content: `Image analysis from ${modelKey(model)} for the user's attached image(s):\n\n${analysis}`,
					display: true,
					details: { model: modelKey(model), imageCount: event.images.length },
				},
			};
		} catch (error) {
			if (!ctx.signal?.aborted) ctx.ui.notify(`Image analysis failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			ctx.ui.setStatus("image-analysis", "");
		}
	});
}
