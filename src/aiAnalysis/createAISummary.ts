import { JobContext, JSONObject, JSONValue, ScheduledJobEvent } from "@devvit/public-api";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import { getUserInfoForOpenAI } from "./gatherUserDetailsForOpenAI.js";
import json2md from "json2md";
import { callOpenAI } from "./openAI.js";
import { addDays, addMinutes, differenceInDays } from "date-fns";
import { getPromptData, PromptData } from "./common.js";
import { getControlSubSettings } from "../settings.js";
import pluralize from "pluralize";
import { hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-helpers";
import OpenAI from "openai";

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

function getCacheKeyForUserSummary (username: string) {
    return `aiSummary:${username}`;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type OpenAISummaryGatherData = {
    jobGuid?: string;
    username: string;
    conversationId?: string;
    postId?: string;
    promptName?: string;
};

export async function generateOpenAISummary (event: ScheduledJobEvent<OpenAISummaryGatherData | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        console.error(`generateOpenAISummary should only run on subreddit ${CONTROL_SUBREDDIT}, but is running on ${context.subredditName}`);
        return;
    }

    const jobGuid = event.data?.jobGuid;
    if (jobGuid && await hasTriggerBeenHandled(context.redis, `job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`AI Summary: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const username = event.data?.username;
    const conversationId = event.data?.conversationId;
    const postId = event.data?.postId;

    if (!username || (!conversationId && !postId)) {
        console.error("Missing username or conversationId/postId in job event data");
        return;
    }

    const cacheKey = getCacheKeyForUserSummary(username);
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

    let prompt: string = promptData.prompt;
    if (event.data?.promptName) {
        const altPrompt = promptData.altPrompts?.[event.data.promptName];
        if (!altPrompt) {
            console.error(`Error: Prompt name ${event.data.promptName} not found in prompt data`);
            await createResponse({
                conversationId,
                postId,
                output: json2md([
                    { p: "**OpenAI Summary**. Use these results as a guide as they may be inaccurate." },
                    { p: `Error generating OpenAI summary: prompt name ${event.data.promptName} not found in prompt data. Please contact the developers to resolve this issue.` },
                ]),
            }, context);
            return;
        }
        prompt = altPrompt;
    }

    const controlSubSettings = await getControlSubSettings(context);

    const userInfo = await getUserInfoForOpenAI(username, context);

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

    const accountAgeInDays = differenceInDays(new Date(), userInfo.userInfo.createdAt);
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

    const jobData: Record<string, JSONValue> = {
        username,
        model: promptData.model,
        prompt,
        payload: JSON.stringify(userInfo),
        jobGuid: crypto.randomUUID(),
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

    const jobGuid = event.data?.jobGuid as string | undefined;
    if (jobGuid && await hasTriggerBeenHandled(context.redis, `job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`OpenAI Summary Lookup: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const username = event.data?.username as string | undefined;
    const conversationId = event.data?.conversationId as string | undefined;
    const postId = event.data?.postId as string | undefined;
    const model = event.data?.model as string | undefined;
    const temperature = event.data?.temperature as number | undefined;
    const prompt = event.data?.prompt as string | undefined;
    const payload = event.data?.payload as string | undefined;

    if (!username || !prompt || !payload || (!conversationId && !postId)) {
        console.error("Missing username, prompt or conversationId/postId in job event data");
        return;
    }

    const structuredPrompt: OpenAI.Responses.ResponseInput = [
        {
            role: "system",
            content: prompt,
        },
        {
            role: "user",
            content: payload,
        },
    ];

    const result = await callOpenAI({
        model,
        temperature,
        prompt: structuredPrompt,
    }, context);

    const cacheKey = getCacheKeyForUserSummary(username);
    await context.redis.set(cacheKey, result, { expiration: addDays(new Date(), 1) });

    await createResponse({
        conversationId,
        postId,
        output: `**OpenAI Summary**. Use these results as a guide as they may be inaccurate.\n\n${result}`,
    }, context);

    console.log(`AI Summary: Finished generating OpenAI summary about user ${username}`);

    await context.scheduler.runJob({
        name: ControlSubredditJob.OpenAIUpdateTokenStatsMessage,
        runAt: new Date(),
        data: { jobGuid: crypto.randomUUID() },
    });
}
