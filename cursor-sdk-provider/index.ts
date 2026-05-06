import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Agent } from "@cursor/sdk";

const PROVIDER = "cursor-sdk";
const API = "cursor-sdk-api";

function contextToPrompt(context: Context): string {
	const parts: string[] = [];
	if (context.systemPrompt) parts.push(`# System instructions\n${context.systemPrompt}`);
	for (const msg of context.messages) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : msg.content.map((c) => c.type === "text" ? c.text : "[image]").join("\n");
			parts.push(`# User\n${text}`);
		} else if (msg.role === "assistant") {
			parts.push(`# Assistant\n${msg.content.map((c) => c.type === "text" ? c.text : c.type === "thinking" ? c.thinking : `[tool_call ${c.name}]`).join("\n")}`);
		} else if (msg.role === "toolResult") {
			parts.push(`# Tool result (${msg.toolName})\n${msg.content.map((c) => c.type === "text" ? c.text : "[image]").join("\n")}`);
		}
	}
	return parts.join("\n\n");
}

function streamCursorSdk(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let agent: any;
		try {
			stream.push({ type: "start", partial: output });
			const params = [] as Array<{ id: string; value: string }>;
			if (model.id === "composer-2") {
				// Composer 2 reasoning is locked by Cursor; use Pi's thinking toggle as a fast-mode toggle instead.
				// off => normal Composer 2, any enabled thinking level => Composer 2 Fast.
				params.push({ id: "fast", value: options?.reasoning ? "true" : "false" });
			} else if (options?.reasoning) {
				params.push({ id: "thinking", value: (((model as any).thinkingLevelMap?.[options.reasoning] ?? options.reasoning) as string) });
			}
			const cursorModel = {
				id: model.id,
				...(params.length > 0 ? { params } : {}),
			};
			agent = await Agent.create({
				apiKey: options?.apiKey || process.env.CURSOR_API_KEY || "",
				model: cursorModel,
				local: { cwd: process.cwd(), settingSources: ["project", "user", "plugins"] },
			});
			const run = await agent.send(contextToPrompt(context));
			let textBlock: TextContent | undefined;
			let thinkingBlock: any;
			const toolBlocks = new Map<string, ToolCall>();

			const ensureText = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					output.content.push(textBlock);
					stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
				}
				return { block: textBlock, index: output.content.indexOf(textBlock) };
			};

			for await (const event of run.stream()) {
				if (options?.signal?.aborted) {
					await run.cancel();
					throw new Error("Request was aborted");
				}
				if (event.type === "assistant") {
					for (const block of event.message.content) {
						if (block.type === "text") {
							const { block: out, index } = ensureText();
							out.text += block.text;
							stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: output });
						} else if (block.type === "tool_use") {
							const toolCall: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: block.input as any };
							output.content.push(toolCall);
							const index = output.content.length - 1;
							stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
							stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
						}
					}
				} else if (event.type === "thinking") {
					if (!thinkingBlock) {
						thinkingBlock = { type: "thinking", thinking: "" };
						output.content.push(thinkingBlock);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					}
					thinkingBlock.thinking += event.text;
					stream.push({ type: "thinking_delta", contentIndex: output.content.indexOf(thinkingBlock), delta: event.text, partial: output });
				} else if (event.type === "tool_call" && event.status !== "running") {
					// Cursor SDK tool payloads are not stable; expose completion as text for visibility.
				}
			}
			if (textBlock) stream.push({ type: "text_end", contentIndex: output.content.indexOf(textBlock), content: textBlock.text, partial: output });
			if (thinkingBlock) stream.push({ type: "thinking_end", contentIndex: output.content.indexOf(thinkingBlock), content: thinkingBlock.thinking, partial: output });
			const result = await run.wait();
			output.stopReason = result.status === "finished" ? "stop" : result.status === "cancelled" ? "aborted" : "error";
			if (result.durationMs) output.responseId = run.id;
			stream.push({ type: output.stopReason === "stop" ? "done" : "error", reason: output.stopReason as any, ...(output.stopReason === "stop" ? { message: output } : { error: output }) } as any);
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			await agent?.[Symbol.asyncDispose]?.().catch?.(() => undefined);
		}
	})();
	return stream;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER, {
		name: "Cursor SDK",
		baseUrl: "cursor-sdk://local",
		apiKey: "CURSOR_API_KEY",
		api: API,
		models: [
			{
				id: "gpt-5.5",
				name: "GPT-5.5 (Cursor SDK)",
				reasoning: true,
				thinkingLevelMap: { off: null, xhigh: "high" },
				input: ["text"],
				cost: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 32000,
			} as any,
			{
				id: "composer-2",
				name: "Cursor Composer 2 (thinking toggles fast)",
				reasoning: true,
				// Cursor does not expose a controllable reasoning level for Composer 2.
				// Keeping reasoning=true lets Pi's thinking control act as an on/off switch for fast mode.
				thinkingLevelMap: { minimal: "fast", low: "fast", medium: "fast", high: "fast", xhigh: "fast" },
				input: ["text"],
				cost: { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 32000,
			} as any,
			{ id: "auto", name: "Cursor Auto", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000 },
		],
		streamSimple: streamCursorSdk,
	});
}
