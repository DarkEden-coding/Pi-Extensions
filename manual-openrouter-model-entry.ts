import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MODELS_JSON_PATH = join(getAgentDir(), "models.json");
const PROVIDER = "openrouter";
const COMMAND = "openrouter-model-selector";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

type InputAbility = "text" | "image";

type ModelEntry = Record<string, unknown> & {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: InputAbility[];
	contextWindow?: number;
	maxTokens?: number;
};

type ProviderConfig = Record<string, unknown> & {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	compat?: unknown;
	authHeader?: boolean;
	models?: ModelEntry[];
	modelOverrides?: Record<string, unknown>;
};

type ModelsJson = {
	providers: Record<string, ProviderConfig>;
};

type OpenRouterModel = {
	id: string;
	name?: string;
	context_length?: number;
	supported_parameters?: string[];
	architecture?: {
		modality?: string | string[];
	};
	top_provider?: {
		max_completion_tokens?: number;
	};
};

type OpenRouterModality = string | string[] | undefined;

function emptyConfig(): ModelsJson {
	return { providers: {} };
}

function parseIds(text: string): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();

	for (const rawLine of text.split(/\r?\n/)) {
		const withoutComment = rawLine.replace(/#.*/, "").trim();
		if (!withoutComment) continue;

		for (const part of withoutComment.split(/[,\s]+/)) {
			const id = part.trim();
			if (!id || seen.has(id)) continue;
			seen.add(id);
			ids.push(id);
		}
	}

	return ids;
}

function getInputAbilities(modality: OpenRouterModality): InputAbility[] {
	const input: InputAbility[] = ["text"];
	const modalities = Array.isArray(modality)
		? modality
		: typeof modality === "string"
			? modality.split(/[\s,+/|;-]+/)
			: [];

	if (modalities.some((value) => {
		const normalized = value.trim().toLowerCase();
		return normalized === "image" || normalized === "vision";
	})) {
		input.push("image");
	}

	return input;
}

async function loadModelsJson(): Promise<ModelsJson> {
	try {
		const raw = await readFile(MODELS_JSON_PATH, "utf8");
		const parsed = JSON.parse(raw) as Partial<ModelsJson>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return emptyConfig();
		}
		if (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
			parsed.providers = {};
		}
		return parsed as ModelsJson;
	} catch (error) {
		if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return emptyConfig();
		}
		throw error;
	}
}

function getCurrentIds(config: ModelsJson): string[] {
	return config.providers[PROVIDER]?.models?.map((model) => model.id) ?? [];
}

function hasProviderMetadata(provider: ProviderConfig): boolean {
	return Object.keys(provider).some((key) => key !== "models");
}

async function saveModelsJson(config: ModelsJson): Promise<void> {
	if (Object.keys(config.providers).length === 0) {
		try {
			await unlink(MODELS_JSON_PATH);
		} catch (error) {
			if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
				throw error;
			}
		}
		return;
	}

	await mkdir(getAgentDir(), { recursive: true });
	await writeFile(MODELS_JSON_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function fetchOpenRouterModels(): Promise<Map<string, OpenRouterModel>> {
	const response = await fetch(OPENROUTER_MODELS_URL);
	if (!response.ok) {
		throw new Error(`OpenRouter API request failed (${response.status} ${response.statusText})`);
	}

	const data = (await response.json()) as { data?: OpenRouterModel[] };
	const models = Array.isArray(data.data) ? data.data : [];
	return new Map(models.map((model) => [model.id, model] as const));
}

function buildNextModels(
	existingModels: ModelEntry[],
	ids: string[],
	metadataById: Map<string, OpenRouterModel>,
): { models: ModelEntry[]; missingIds: string[] } {
	const existingById = new Map(existingModels.map((model) => [model.id, model] as const));
	const missingIds: string[] = [];

	const models = ids.map((id) => {
		const metadata = metadataById.get(id);
		if (!metadata) {
			missingIds.push(id);
			return existingById.get(id) ?? { id, name: id };
		}

		const existing = existingById.get(id);
		return {
			...(existing ?? {}),
			id: metadata.id,
			name: metadata.name ?? existing?.name ?? id,
			api: "openai-completions",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: metadata.supported_parameters?.includes("reasoning") ?? false,
			input: getInputAbilities(metadata.architecture?.modality),
			contextWindow: metadata.context_length ?? 4096,
			maxTokens: metadata.top_provider?.max_completion_tokens ?? metadata.context_length ?? 4096,
		} satisfies ModelEntry;
	});

	return { models, missingIds };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand(COMMAND, {
		description: "Edit manual OpenRouter model ids for /openrouter-model-selector and Ctrl+P cycling",
		handler: async (args, ctx) => {
			try {
				const config = await loadModelsJson();
				const provider: ProviderConfig = config.providers[PROVIDER] ?? {};
				const currentIds = getCurrentIds(config);
				const hasModelsProperty = Object.prototype.hasOwnProperty.call(provider, "models");

				let input = args.trim();
				if (!input) {
					if (!ctx.hasUI) {
						ctx.ui.notify(`/${COMMAND} needs interactive mode or arguments`, "error");
						return;
					}

					const edited = await ctx.ui.editor(
						"OpenRouter model ids (one per line; commas also work)",
						currentIds.join("\n"),
					);
					if (edited === undefined) {
						ctx.ui.notify("Cancelled", "info");
						return;
					}
					input = edited;
				}

				const nextIds = parseIds(input);
				if (nextIds.length === 0) {
					if (!hasModelsProperty && !hasProviderMetadata(provider)) {
						ctx.ui.notify("No manual OpenRouter models to clear", "info");
						return;
					}

					if (currentIds.length > 0 && ctx.hasUI) {
						const ok = await ctx.ui.confirm(
							"Clear OpenRouter models?",
							"Remove all manual OpenRouter model ids?",
						);
						if (!ok) return;
					}

					if (hasModelsProperty) {
						delete provider.models;
					}

					if (hasProviderMetadata(provider)) {
						config.providers[PROVIDER] = provider;
					} else {
						delete config.providers[PROVIDER];
					}

					await saveModelsJson(config);
					ctx.modelRegistry.refresh();
					ctx.ui.notify("Cleared manual OpenRouter models", "info");
					return;
				}

				const metadataById = await fetchOpenRouterModels();
				const { models: nextModels, missingIds } = buildNextModels(provider.models ?? [], nextIds, metadataById);
				if (missingIds.length > 0) {
					ctx.ui.notify(
						`Unknown OpenRouter model id${missingIds.length === 1 ? "" : "s"}: ${missingIds.join(", ")}`,
						"error",
					);
					return;
				}

				provider.models = nextModels;
				config.providers[PROVIDER] = provider;

				await saveModelsJson(config);
				ctx.modelRegistry.refresh();
				ctx.ui.notify(
					`Saved ${nextIds.length} verified OpenRouter model id${nextIds.length === 1 ? "" : "s"}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Failed to update ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
