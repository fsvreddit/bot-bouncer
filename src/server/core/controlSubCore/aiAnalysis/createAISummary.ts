import { context, reddit, redis, scheduler, TaskRequest } from "@devvit/web/server";
import { T3 } from "@devvit/web/shared";
import { CONTROL_SUBREDDIT, ControlSubredditJob, getControlSubSettings } from "../..";
import { addDays, addMinutes, differenceInDays } from "date-fns";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { getPromptData, PromptData } from "./common";
import json2md from "json2md";
import { getUserInfoForOpenAI } from "./gatherUserDetailsForOpenAI";
import pluralize from "pluralize";
import { callOpenAI } from "./openAI";
import OpenAI from "openai";
import { OpenAISummaryGatherData, OpenAISummaryLookupAndRespondData, UpdateTokenStatsMessageData } from "../../../tasks";

export async function createResponse (opts: { conversationId?: string; postId?: T3; output: string }) {
    const { conversationId, postId, output } = opts;
    if (conversationId) {
        await reddit.modMail.reply({
            conversationId,
            body: output,
            isInternal: true,
        });
    }
    if (postId) {
        const newComment = await reddit.submitComment({
            id: postId,
            text: output,
        });
        await newComment.remove();
    }
}

function getCacheKeyForUserSummary (username: string) {
    return `aiSummary:${username}`;
}

export async function generateOpenAISummary (event: TaskRequest<OpenAISummaryGatherData>) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        console.error(`generateOpenAISummary should only run on subreddit ${CONTROL_SUBREDDIT}, but is running on ${context.subredditName}`);
        return;
    }

    const jobGuid = event.data.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`AI Summary: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const username = event.data.username;
    const conversationId = event.data.conversationId;
    const postId = event.data.postId;

    if (!username || (!conversationId && !postId)) {
        console.error("Missing username or conversationId/postId in job event data");
        return;
    }

    const cacheKey = getCacheKeyForUserSummary(username);
    const cachedSummary = await redis.get(cacheKey);
    if (!event.data.promptName && cachedSummary) {
        console.log(`AI Summary: Using cached summary for user ${username}`);
        await createResponse({
            conversationId,
            postId: postId as T3,
            output: `**OpenAI Summary**. Use these results as a guide as they may be inaccurate. **Note**: This is a cached summary, not live.\n\n${cachedSummary}`,
        });
        return;
    }

    console.log(`AI Summary: Generating OpenAI summary about user ${username}`);

    let promptData: PromptData;
    try {
        promptData = await getPromptData("prompts/modmail-summary");
    } catch (error) {
        console.error("Error getting prompt data", error);
        const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        await createResponse({
            conversationId,
            postId: postId as T3,
            output: json2md([
                { p: "**OpenAI Summary**. Use these results as a guide as they may be inaccurate." },
                { p: "Error generating OpenAI summary: unable to load prompt data. Please contact the developers to resolve this issue." },
                { blockquote: errorMessage },
            ]),
        });
        return;
    }

    let prompt: string = promptData.prompt;
    if (event.data.promptName) {
        const altPrompt = promptData.altPrompts?.[event.data.promptName];
        if (!altPrompt) {
            console.error(`Error: Prompt name ${event.data.promptName} not found in prompt data`);
            await createResponse({
                conversationId,
                postId: postId as T3,
                output: json2md([
                    { p: "**OpenAI Summary**. Use these results as a guide as they may be inaccurate." },
                    { p: `Error generating OpenAI summary: prompt name ${event.data.promptName} not found in prompt data. Please contact the developers to resolve this issue.` },
                ]),
            });
            return;
        }
        prompt = altPrompt;
    }

    const controlSubSettings = await getControlSubSettings();

    const userInfo = await getUserInfoForOpenAI(username);

    if (!userInfo) {
        await createResponse({
            conversationId,
            postId: postId as T3,
            output: json2md([
                { p: "**OpenAI Summary**. Use these results as a guide as they may be inaccurate." },
                { p: `Error generating OpenAI summary: could not retrieve user information for ${username}. This may be because the user does not exist or is suspended.` },
            ]),
        });
        return;
    }

    const reasonsToSkipCreation: string[] = [];
    const minimumAccountAgeInDays = controlSubSettings.openAIMinimumAccountAgeInDays ?? 30;
    const minimumContentItems = controlSubSettings.openAIMinimumContentCount ?? 25;

    if (event.data.mode === "auto") {
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
                postId: postId as T3,
                output: json2md([
                    { p: "**OpenAI Summary**." },
                    { p: "This user does not meet the requirements for generating an OpenAI summary because of the following reasons:" },
                    { ul: reasonsToSkipCreation },
                ]),
            });
            return;
        }
    }

    const jobData: OpenAISummaryLookupAndRespondData = {
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

    await scheduler.runJob<OpenAISummaryLookupAndRespondData>({
        name: ControlSubredditJob.OpenAISummaryLookup,
        data: jobData,
        runAt: new Date(),
    });
}

export async function openAISummaryLookupAndRespond (event: TaskRequest<OpenAISummaryLookupAndRespondData>) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        console.error(`openAISummaryLookupAndRespond should only run on subreddit ${CONTROL_SUBREDDIT}, but is running on ${context.subredditName}`);
        return;
    }

    const jobGuid = event.data.jobGuid as string | undefined;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`OpenAI Summary Lookup: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const username = event.data.username;
    const conversationId = event.data.conversationId;
    const postId = event.data.postId;
    const model = event.data.model;
    const temperature = event.data.temperature;
    const prompt = event.data.prompt;
    const payload = event.data.payload;

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
    });

    const cacheKey = getCacheKeyForUserSummary(username);
    await redis.set(cacheKey, result, { expiration: addDays(new Date(), 1) });

    await createResponse({
        conversationId,
        postId: postId as T3,
        output: `**OpenAI Summary**. Use these results as a guide as they may be inaccurate.\n\n${result}`,
    });

    console.log(`AI Summary: Finished generating OpenAI summary about user ${username}`);

    await scheduler.runJob<UpdateTokenStatsMessageData>({
        name: ControlSubredditJob.OpenAIUpdateTokenStatsMessage,
        runAt: new Date(),
        data: { jobGuid: crypto.randomUUID() },
    });
}
