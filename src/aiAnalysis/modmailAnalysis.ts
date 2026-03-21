import { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { getUserInfoForOpenAI } from "./gatherUserDetailsForOpenAI.js";
import { parseAllDocuments } from "yaml";
import _ from "lodash";
import { EvaluationResult, getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import { callOpenAI } from "./openAI.js";

interface ModmailPromptData {
    model: string;
    temperature?: number;
    prompt: string[];
}

async function getPromptData (context: JobContext): Promise<ModmailPromptData> {
    const promptCacheKey = "modmailSummaryPrompt";
    const cachedPrompt = await context.redis.get(promptCacheKey);
    if (cachedPrompt) {
        return JSON.parse(cachedPrompt) as ModmailPromptData;
    }

    const wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, "prompts/modmail-summary");
    const content = _.compact(parseAllDocuments(wikiPage.content).map(doc => doc.toJSON() as ModmailPromptData));

    if (content.length === 0) {
        throw new Error("No valid prompt data found in wiki page");
    }

    const promptData = content[0];
    await context.redis.set(promptCacheKey, JSON.stringify(promptData));
    return promptData;
}

function evaluationResultsToBulletPoints (input: EvaluationResult[]): string[] {
    const bullets: string[] = [];
    for (const reason of input) {
        if (typeof reason.hitReason === "string") {
            bullets.push(`${reason.botName}: ${reason.hitReason}`);
        } else if (reason.hitReason?.details) {
            bullets.push(`${reason.botName}: ${reason.hitReason.reason}`);
        }
    }

    return bullets;
}

export async function generateOpenAISummaryForModmail (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        console.error(`generateOpenAISummaryForModmail should only run on subreddit ${CONTROL_SUBREDDIT}, but is running on ${context.subredditName}`);
        return;
    }

    const username = event.data?.username as string | undefined;
    const conversationId = event.data?.conversationId as string | undefined;

    if (!username || !conversationId) {
        console.error("Missing username or conversationId in job event data");
        return;
    }

    const userInfo = await getUserInfoForOpenAI(username, context);
    const promptData = await getPromptData(context);

    console.log(JSON.stringify(promptData));

    const completedPrompt: string[] = [];
    for (const entry of promptData.prompt) {
        let promptLine = entry.replaceAll("{{username}}", username);
        promptLine = promptLine.replaceAll("{{userInfo}}", JSON.stringify(userInfo));

        if (promptLine.includes("{{initialEvaluationResults}}")) {
            const initialReasons = await getAccountInitialEvaluationResults(username, context);

            const bullets = evaluationResultsToBulletPoints(initialReasons);
            if (bullets.length > 0) {
                const text: json2md.DataObject[] = [
                    { p: "At the point the user was flagged, they were detected by automatic checks for the following reasons:" },
                    { ul: bullets },
                ];
                completedPrompt.push(json2md(text));
            }

            continue;
        }

        completedPrompt.push(promptLine);
    }

    const result = await callOpenAI({
        model: promptData.model,
        temperature: promptData.temperature,
        prompt: completedPrompt.join("\n\n"),
    }, context);

    await context.reddit.modMail.reply({
        conversationId,
        body: `**OpenAI Summary:**\n\n${result}`,
        isInternal: true,
    });
}
