import { GetConversationResponse, ModMailConversationState, TriggerContext } from "@devvit/public-api";
import { ModMail } from "@devvit/protos";
import { addMonths } from "date-fns";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { getSummaryForUser } from "../UserSummary/userSummary.js";
import { handleClientSubredditModmail } from "./clientSubModmail.js";
import { handleControlSubredditModmail, markdownToText } from "./controlSubModmail.js";
import { dataExtract } from "./dataExtract.js";
import { addAllUsersFromModmail } from "../similarBioTextFinder/bioTextFinder.js";
import { UserStatus } from "../dataStore.js";
import json2md from "json2md";

function conversationHandledRedisKey (conversationId: string) {
    return `conversationHandled~${conversationId}`;
}

export async function getConversationHandled (conversationId: string, context: TriggerContext) {
    const redisKey = conversationHandledRedisKey(conversationId);
    return await context.redis.exists(redisKey);
}

export async function setConversationHandled (conversationId: string, context: TriggerContext) {
    await context.redis.set(conversationHandledRedisKey(conversationId), "true", { expiration: addMonths(new Date(), 6) });
}

export async function handleModmail (event: ModMail, context: TriggerContext) {
    let conversationResponse: GetConversationResponse;
    try {
        conversationResponse = await context.reddit.modMail.getConversation({
            conversationId: event.conversationId,
        });
    } catch (error) {
        console.log("Error in modmail event:", JSON.stringify(event, null, 2));
        console.log(error);
        return;
    }

    if (!conversationResponse.conversation) {
        return;
    }

    const messagesInConversation = Object.values(conversationResponse.conversation.messages);
    const firstMessage = messagesInConversation[0];
    const isFirstMessage = firstMessage.id !== undefined && event.messageId.includes(firstMessage.id);

    const currentMessage = messagesInConversation.find(message => message.id && event.messageId.includes(message.id));

    const isExtracttCommand = context.subredditName === CONTROL_SUBREDDIT && currentMessage?.bodyMarkdown?.startsWith("!extract");
    if (isExtracttCommand) {
        await dataExtract(currentMessage?.bodyMarkdown, event.conversationId, context);
        return;
    }

    if (currentMessage?.bodyMarkdown) {
        const addAllRegex = /^!addall(?: (banned))?/;
        const addAllMatches = addAllRegex.exec(currentMessage.bodyMarkdown);
        if (context.subredditName === CONTROL_SUBREDDIT && addAllMatches && addAllMatches.length === 2) {
            const status = addAllMatches[1] === "banned" ? UserStatus.Banned : UserStatus.Pending;
            await addAllUsersFromModmail(event.conversationId, currentMessage.author?.name, status, context);
            return;
        }
    }

    const username = conversationResponse.conversation.participant?.name;
    if (!username) {
        return;
    }

    const isSummaryCommand = context.subredditName === CONTROL_SUBREDDIT && currentMessage?.bodyMarkdown?.startsWith("!summary");

    if (isSummaryCommand) {
        await addSummaryForUser(event.conversationId, username, context);
        return;
    }

    const conversationHandled = await getConversationHandled(event.conversationId, context);
    if (conversationHandled) {
        return;
    }

    await setConversationHandled(event.conversationId, context);

    if (context.subredditName === CONTROL_SUBREDDIT) {
        if (isFirstMessage && firstMessage.author?.name === username) {
            await handleControlSubredditModmail(username, event.conversationId, isFirstMessage, conversationResponse.conversation.subject, currentMessage?.bodyMarkdown, context);
        }
    } else {
        if (conversationResponse.conversation.state === ModMailConversationState.Archived) {
            return;
        }
        await handleClientSubredditModmail(username, event.conversationId, context);
    }
}

async function addSummaryForUser (conversationId: string, username: string, context: TriggerContext) {
    const userSummary = await getSummaryForUser(username, "modmail", context);
    const shadowbannedSummary: json2md.DataObject[] = [
        { p: "No summary available, user may be shadowbanned." },
    ];
    const messageText = userSummary ?? shadowbannedSummary;

    const modmailStrings = markdownToText(messageText);

    for (const string of modmailStrings) {
        await context.reddit.modMail.reply({
            body: string,
            conversationId,
            isInternal: true,
        });
    }
}
