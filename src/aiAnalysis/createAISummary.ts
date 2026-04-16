import { JobContext, JSONObject, JSONValue, ScheduledJobEvent } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import { getUserInfoForOpenAI } from "./gatherUserDetailsForOpenAI.js";
import { EvaluationResult, getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import { callOpenAI } from "./openAI.js";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";
import { addHours, differenceInDays } from "date-fns";
import { getPromptData, PromptData } from "./common.js";
import { getControlSubSettings } from "../settings.js";
import pluralize from "pluralize";

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

    if (!username || (!conversationId && !postId)) {
        console.error("Missing username or conversationId/postId in job event data");
        return;
    }

    const cacheKey = `aiSummary:${username}`;
    const cachedSummary = await context.redis.get(cacheKey);
    if (cachedSummary) {
        console.log(`AI Summary: Using cached summary for user ${username}`);
        await createResponse({
            conversationId,
            postId,
            output: `**OpenAI Summary**. Use these results as a guide as they may be inaccurate. **Note**: This is a cached summary, not live.\n\n${cachedSummary}`,
        }, context);
        return;
    }

    console.log(`AI Summary: Generating OpenAI summary about user ${username}`);

    let promptData: PromptData;
    try {
        promptData = await getPromptData("prompts/modmail-summary", context);
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

    const [userInfo, modNotes, evaluatorVariables, controlSubSettings] = await Promise.all([
        getUserInfoForOpenAI(username, context),
        context.reddit.getModNotes({
            user: username,
            subreddit: CONTROL_SUBREDDIT,
            filter: "NOTE",
        }).all(),
        getEvaluatorVariables(context),
        getControlSubSettings(context),
    ]);

    if (!userInfo) {
        await createResponse({
            conversationId,
            postId,
            output: json2md([
                { p: "**OpenAI Summary**. Use these results as a guide as they may be inaccurate." },
                { p: `Error generating OpenAI summary: could not retrieve user information for ${username}. This may be because the user does not exist or is suspended.` },
            ]),
        }, context);
        return;
    }

    const reasonsToSkipCreation: string[] = [];
    const minimumAccountAgeInDays = controlSubSettings.openAIMinimumAccountAgeInDays ?? 30;
    const minimumContentItems = controlSubSettings.openAIMinimumContentCount ?? 25;

    const accountAgeInDays = userInfo.userInfo.createdAt ? differenceInDays(new Date(), userInfo.userInfo.createdAt) : undefined;
    if (!accountAgeInDays || accountAgeInDays < minimumAccountAgeInDays) {
        reasonsToSkipCreation.push(`The account is ${accountAgeInDays} ${pluralize("day", accountAgeInDays)} old, which is less than the minimum required ${minimumAccountAgeInDays} days`);
    }

    if (userInfo.history.length < minimumContentItems) {
        reasonsToSkipCreation.push(`The user has only ${userInfo.history.length} content ${pluralize("item", userInfo.history.length)}, which is less than the minimum required ${minimumContentItems} items`);
    }

    if (reasonsToSkipCreation.length > 0) {
        await createResponse({
            conversationId,
            postId,
            output: json2md([
                { p: "**OpenAI Summary**." },
                { p: "This user does not meet the requirements for generating an OpenAI summary because of the following reasons:" },
                { ul: reasonsToSkipCreation },
            ]),
        }, context);
        return;
    }

    const completedPrompt: string[] = [];
    for (const entry of promptData.prompt.split("\n").map(line => line.trim())) {
        const promptLine = entry.replaceAll("{{username}}", username);

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

    completedPrompt.push(JSON.stringify(userInfo));

    const jobData: Record<string, JSONValue> = {
        username,
        model: promptData.model,
        prompt: completedPrompt.join("\n\n"),
    };

    if (postId) {
        jobData.postId = postId;
    }

    if (conversationId) {
        jobData.conversationId = conversationId;
    }

    if (promptData.temperature !== undefined) {
        jobData.temperature = promptData.temperature;
    }

    await context.scheduler.runJob({
        name: ControlSubredditJob.OpenAISummaryLookup,
        data: jobData,
        runAt: new Date(),
    });
}

export async function openAISummaryLookupAndRespond (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        console.error(`openAISummaryLookupAndRespond should only run on subreddit ${CONTROL_SUBREDDIT}, but is running on ${context.subredditName}`);
        return;
    }

    const username = event.data?.username as string | undefined;
    const conversationId = event.data?.conversationId as string | undefined;
    const postId = event.data?.postId as string | undefined;
    const model = event.data?.model as string | undefined;
    const temperature = event.data?.temperature as number | undefined;
    const prompt = event.data?.prompt as string | undefined;

    if (!username || !prompt || (!conversationId && !postId)) {
        console.error("Missing username, promp or conversationId/postId in job event data");
        return;
    }

    const result = await callOpenAI({
        model,
        temperature,
        prompt,
    }, context);

    const cacheKey = `cachedAISummary:${username}`;
    await context.redis.set(cacheKey, result, { expiration: addHours(new Date(), 6) });

    await createResponse({
        conversationId,
        postId,
        output: `**OpenAI Summary**. Use these results as a guide as they may be inaccurate.\n\n${result}`,
    }, context);

    console.log(`AI Summary: Finished generating OpenAI summary about user ${username}`);
}
