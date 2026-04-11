import { TriggerContext } from "@devvit/public-api";
import { ModmailMessage } from "../modmail/modmail.js";
import { getPromptData, PromptData } from "./common.js";
import { getUserInfoForOpenAI } from "./gatherUserDetailsForOpenAI.js";
import { callOpenAI } from "./openAI.js";

export async function handleAskAI (modmail: ModmailMessage, context: TriggerContext) {
    if (!modmail.bodyMarkdown.startsWith("!askai")) {
        throw new Error("Ask AI: Invalid command");
    }

    if (!modmail.participant) {
        await context.reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: "Error: Could not determine the user to ask about.",
            isInternal: true,
        });
        return;
    }

    const question = modmail.bodyMarkdown.substring("!askai".length).trim();
    if (question.length === 0) {
        await context.reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: "Error: No question provided. Please provide a question after the !askai command.",
            isInternal: true,
        });
        return;
    }

    const blockQuotedQuestion = question.split("\n").map(line => `> ${line}`).join("\n");

    let promptData: PromptData;
    try {
        promptData = await getPromptData("prompts/ask-ai", context);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        await context.reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: `Error retrieving prompt data: ${errorMessage}`,
            isInternal: true,
        });
        return;
    }

    const userInfo = await getUserInfoForOpenAI(modmail.participant, context);

    let prompt = promptData.prompt.replace("{{modQuestion}}", blockQuotedQuestion);

    prompt += "\n\n" + JSON.stringify(userInfo, null, 2);

    const result = await callOpenAI({
        model: promptData.model,
        temperature: promptData.temperature,
        prompt,
    }, context);

    await context.reddit.modMail.reply({
        conversationId: modmail.conversationId,
        body: `**OpenAI Response**. Use this response as a guide as it may be inaccurate.\n\n${result}`,
        isInternal: true,
    });
}
