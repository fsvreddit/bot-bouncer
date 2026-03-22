import { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { getUserInfoForOpenAI } from "./gatherUserDetailsForOpenAI.js";
import { parseAllDocuments } from "yaml";
import _ from "lodash";
import { EvaluationResult, getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import { callOpenAI } from "./openAI.js";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";
import Ajv, { JSONSchemaType } from "ajv";

interface ModmailPromptData {
    model: string;
    temperature?: number;
    prompt: string[];
}

const promptSchema: JSONSchemaType<ModmailPromptData> = {
    type: "object",
    properties: {
        model: { type: "string" },
        temperature: { type: "number", nullable: true },
        prompt: { type: "array", items: { type: "string" } },
    },
    required: ["model", "prompt"],
    additionalProperties: false,
};

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

    const ajv = new Ajv.default();
    const validate = ajv.compile(promptSchema);
    if (!validate(promptData)) {
        console.error("Prompt validation failed", validate.errors);
        throw new Error(`Prompt validation failed: ${ajv.errorsText(validate.errors)}`);
    }

    await context.redis.set(promptCacheKey, JSON.stringify(promptData));
    return promptData;
}

function evaluationResultsToBulletPoints (input: EvaluationResult[], evaluatorVariables: Record<string, unknown>): string[] {
    const bullets: string[] = [];
    for (const reason of input) {
        let matchReason: string | undefined;
        if (typeof reason.hitReason === "string") {
            matchReason = `${reason.botName}: ${reason.hitReason}`;
        } else if (reason.hitReason?.details) {
            matchReason = `${reason.botName}: ${reason.hitReason.reason}`;
        }

        if (matchReason) {
            const keys = Object.keys(evaluatorVariables).filter(key => key.split(":")[1] === "name").map(key => key.split(":")[0]);
            for (const key of keys) {
                if (evaluatorVariables[`${key}:name`] === reason.botName) {
                    const description = evaluatorVariables[`${key}:descriptionForAI`] as string | undefined;
                    if (description) {
                        matchReason += ` (${description})`;
                    }
                }
            }
        }

        if (matchReason) {
            bullets.push(matchReason);
        }
    }

    return bullets;
}

export async function createResponse (opts: { conversationId?: string; postId?: string; output: string }, context: JobContext) {
    const { conversationId, postId, output } = opts;
    if (conversationId) {
        await context.reddit.modMail.reply({
            conversationId,
            body: output,
            isInternal: true,
        });
    }
    if (postId) {
        const newComment = await context.reddit.submitComment({
            id: postId,
            text: output,
        });
        await newComment.remove();
    }
}

export async function generateOpenAISummary (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        console.error(`generateOpenAISummary should only run on subreddit ${CONTROL_SUBREDDIT}, but is running on ${context.subredditName}`);
        return;
    }

    const username = event.data?.username as string | undefined;
    const conversationId = event.data?.conversationId as string | undefined;
    const postId = event.data?.postId as string | undefined;
    const minContentItemsNeeded = event.data?.minContentItemsNeeded as number | undefined ?? 5;

    if (!username || (!conversationId && !postId)) {
        console.error("Missing username or conversationId/postId in job event data");
        return;
    }

    console.log(`AI Summary: Generating OpenAI summary about user ${username}`);

    let promptData: ModmailPromptData;
    try {
        promptData = await getPromptData(context);
    } catch (error) {
        console.error("Error getting prompt data", error);
        const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        await createResponse({
            conversationId,
            postId,
            output: json2md([
                { p: "**OpenAI Summary**. Use these results as a guide as they may be inaccurate." },
                { p: "Error generating OpenAI summary: unable to load prompt data. Please contact the developers to resolve this issue." },
                { blockquote: errorMessage },
            ]),
        }, context);
        return;
    }

    const [userInfo, modNotes, evaluatorVariables] = await Promise.all([
        getUserInfoForOpenAI(username, context),
        context.reddit.getModNotes({
            user: username,
            subreddit: CONTROL_SUBREDDIT,
            filter: "NOTE",
        }).all(),
        getEvaluatorVariables(context),
    ]);

    if (userInfo.history.length < minContentItemsNeeded) {
        await createResponse({
            conversationId,
            postId,
            output: json2md([
                { p: "**OpenAI Summary**." },
                { p: `This user has fewer than ${minContentItemsNeeded} posts or comments visible on their profile, so no useful summary can be generated.` },
            ]),
        }, context);
        return;
    }

    const completedPrompt: string[] = [];
    for (const entry of promptData.prompt) {
        let promptLine = entry.replaceAll("{{username}}", username);
        promptLine = promptLine.replaceAll("{{userInfo}}", JSON.stringify(userInfo));

        if (promptLine.includes("{{initialEvaluationResults}}")) {
            const initialReasons = await getAccountInitialEvaluationResults(username, context);

            const bullets = evaluationResultsToBulletPoints(initialReasons, evaluatorVariables);
            if (bullets.length > 0) {
                const text: json2md.DataObject[] = [
                    { p: "At the point the user was flagged, they were detected by automatic checks for the following reasons:" },
                    { ul: bullets },
                ];
                completedPrompt.push(json2md(text));
            }

            continue;
        }

        if (promptLine.includes("{{modNotes}}")) {
            const bullets: string[] = [];
            for (const note of modNotes) {
                if (!note.userNote?.note) {
                    continue;
                }

                if (!note.userNote.label) {
                    continue;
                }
                bullets.push(`${note.createdAt}: ${note.userNote.note}`);
            }
            if (bullets.length > 0) {
                const text: json2md.DataObject[] = [
                    { p: "Notes about the user made by moderators:" },
                    { ul: bullets },
                ];
                if (modNotes.some(note => note.userNote?.note?.includes("VA"))) {
                    text.push({ p: "In a mod note, 'VA' stands for 'Virtual Assistant', i.e. someone paid to promote products or services. " });
                }
                if (modNotes.some(note => note.userNote?.note?.includes("AE"))) {
                    text.push({ p: "In a mod note, 'AE' stands for AliExpress. " });
                }
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

    await createResponse({
        conversationId,
        postId,
        output: `**OpenAI Summary**. Use these results as a guide as they may be inaccurate.\n\n${result}`,
    }, context);

    console.log(`AI Summary: Finished generating OpenAI summary about user ${username}`);
}
