import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";

const questionSchema = Type.Object({
	question: Type.String({ description: "Question to ask the user." }),
	options: Type.Array(Type.String(), {
		description: "Pickable options to show for this question.",
		minItems: 1,
	}),
});

const askUserQuestionsSchema = Type.Object({
	questions: Type.Array(questionSchema, {
		description: "One or more questions to ask the user, in order.",
		minItems: 1,
		maxItems: 20,
	}),
});

export type AskUserQuestionsInput = Static<typeof askUserQuestionsSchema>;

type Answer = {
	question: string;
	answer: string;
	type: "option" | "custom";
	optionIndex?: number;
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_questions",
		label: "Ask User Questions",
		description: "Ask the user a series of questions. Each question has any number of pickable options plus a custom response choice.",
		promptSnippet: "Ask the user one or more multiple-choice questions with an optional custom response.",
		promptGuidelines: [
			"Use ask_user_questions when you need the user's preference, clarification, or choice before proceeding.",
			"For ask_user_questions, provide at least one clear option for each question.",
		],
		parameters: askUserQuestionsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					isError: true,
					content: [{ type: "text", text: "ask_user_questions requires an interactive UI." }],
					details: { answers: [] },
				};
			}

			const answers: Answer[] = [];

			for (let i = 0; i < params.questions.length; i++) {
				const item = params.questions[i]!;
				const choices = [...item.options, "Custom response…"];
				const title = params.questions.length === 1
					? item.question
					: `Question ${i + 1}/${params.questions.length}: ${item.question}`;

				const choice = await ctx.ui.select(title, choices);
				if (choice === undefined) {
					return {
						isError: true,
						content: [{ type: "text", text: "User cancelled the question dialog." }],
						details: { answers, cancelled: true },
					};
				}

				if (choice === "Custom response…") {
					const custom = await ctx.ui.input(`Custom response for: ${item.question}`, "Type your answer");
					if (custom === undefined) {
						return {
							isError: true,
							content: [{ type: "text", text: "User cancelled the custom response dialog." }],
							details: { answers, cancelled: true },
						};
					}
					answers.push({ question: item.question, answer: custom, type: "custom" });
				} else {
					answers.push({
						question: item.question,
						answer: choice,
						type: "option",
						optionIndex: item.options.indexOf(choice),
					});
				}
			}

			const text = answers
				.map((answer, i) => `${i + 1}. ${answer.question}\nAnswer: ${answer.answer}${answer.type === "custom" ? " (custom)" : ""}`)
				.join("\n\n");

			return {
				content: [{ type: "text", text }],
				details: { answers },
			};
		},
	});
}
