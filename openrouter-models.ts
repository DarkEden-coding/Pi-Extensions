import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MODELS_JSON_PATH = join(getAgentDir(), "models.json");
const PROVIDER = "openrouter";

type ModelsJson = {
	providers: Record<
		string,
		{
			baseUrl?: string;
			apiKey?: string;
			api?: string;
			headers?: Record<string, string>;
			compat?: unknown;
			authHeader?: boolean;
			models?: Array<Record<string, unknown> & { id: string; name?: string }>;
			modelOverrides?: Record<string, unknown>;
		}
	>;
};

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
	return (config.providers[PROVIDER]?.models ?? []).map((model) => model.id);
}

function buildNextModels(existingModels: Array<Record<string, unknown> & { id: string; name?: string }>, ids: string[]) {
	const existingById = new Map(existingModels.map((model) => [model.id, model] as const));
	return ids.map((id) => existingById.get(id) ?? { id, name: id });
}

async function saveModelsJson(config: ModelsJson): Promise<void> {
	await mkdir(getAgentDir(), { recursive: true });
	await writeFile(MODELS_JSON_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("models", {
		description: "Edit manual OpenRouter model ids for /model and Ctrl+P cycling",
		handler: async (args, ctx) => {
			try {
				const config = await loadModelsJson();
				const provider = config.providers[PROVIDER] ?? {};
				const currentIds = getCurrentIds(config);

				let input = args.trim();
				if (!input) {
					if (!ctx.hasUI) {
						ctx.ui.notify("/models needs interactive mode or arguments", "error");
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
					if (currentIds.length > 0 && ctx.hasUI) {
						const ok = await ctx.ui.confirm("Clear OpenRouter models?", "Remove all manual OpenRouter model ids?");
						if (!ok) return;
					}

					const hasOverrideConfig =
						provider.baseUrl !== undefined ||
						provider.headers !== undefined ||
						provider.compat !== undefined ||
						(provider.modelOverrides !== undefined && Object.keys(provider.modelOverrides).length > 0);

					if (hasOverrideConfig) {
						delete provider.models;
						config.providers[PROVIDER] = provider;
					} else {
						delete config.providers[PROVIDER];
					}

					await saveModelsJson(config);
					ctx.modelRegistry.refresh();
					ctx.ui.notify("Cleared manual OpenRouter models", "info");
					return;
				}

				provider.models = buildNextModels(provider.models ?? [], nextIds);
				config.providers[PROVIDER] = provider;

				await saveModelsJson(config);
				ctx.modelRegistry.refresh();
				ctx.ui.notify(`Saved ${nextIds.length} OpenRouter model id${nextIds.length === 1 ? "" : "s"}`, "info");
			} catch (error) {
				ctx.ui.notify(
					`Failed to update ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
