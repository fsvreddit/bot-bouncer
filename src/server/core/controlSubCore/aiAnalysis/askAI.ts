import { reddit } from "@devvit/web/server";
import { ModmailMessage } from "../..";
import { getPromptData, PromptData } from "./common";
import OpenAI from "openai";
import { callOpenAI } from "./openAI";
import { getUserInfoForOpenAI } from "./gatherUserDetailsForOpenAI";

export async function handleAskAI (modmail: ModmailMessage) {
    if (!modmail.bodyMarkdown.startsWith("!askai")) {
        throw new Error("Ask AI: Invalid command");
    }

    if (!modmail.participant) {
        await reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: "Error: Could not determine the user to ask about.",
            isInternal: true,
        });
        return;
    }

    const question = modmail.bodyMarkdown.substring("!askai".length).trim();
    if (question.length === 0) {
        await reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: "Error: No question provided. Please provide a question after the !askai command.",
            isInternal: true,
        });
        return;
    }

    let promptData: PromptData;
    try {
        promptData = await getPromptData("prompts/ask-ai");
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        await reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: `Error retrieving prompt data: ${errorMessage}`,
            isInternal: true,
        });
        return;
    }

    const userInfo = await getUserInfoForOpenAI(modmail.participant);
    if (!userInfo) {
        await reddit.modMail.reply({
            conversationId: modmail.conversationId,
            body: `Error: Could not retrieve information for user ${modmail.participant}.`,
            isInternal: true,
        });
        return;
    }

    const structuredPrompt: OpenAI.Responses.ResponseInput = [
        {
            role: "system",
            content: promptData.prompt,
        },
        {
            role: "user",
            content: question,
        },
        {
            role: "user",
            content: JSON.stringify(userInfo, null, 2),
        },
    ];

    const result = await callOpenAI({
        model: promptData.model,
        temperature: promptData.temperature,
        prompt: structuredPrompt,
    });

    await reddit.modMail.reply({
        conversationId: modmail.conversationId,
        body: `**OpenAI Response**. Use this response as a guide as it may be inaccurate.\n\n${result}`,
        isInternal: true,
    });
}
