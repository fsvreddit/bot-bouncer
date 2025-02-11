import { GetConversationResponse, ModMailConversationState, TriggerContext } from "@devvit/public-api";
import { ModMail } from "@devvit/protos";
import { addMonths } from "date-fns";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { getSummaryTextForUser } from "../UserSummary/userSummary.js";
import { handleClientSubredditModmail } from "./clientSubModmail.js";
import { handleControlSubredditModmail } from "./controlSubModmail.js";

function conversationHandledRedisKey (conversationId: string) {
    return `conversationHandled~${conversationId}`;
}

export async function getConversationHandled (conversationId: string, context: TriggerContext) {
    const redisKey = conversationHandledRedisKey(conversationId);
    const handled = await context.redis.get(redisKey);
    return handled !== undefined;
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
        console.log(error);
        return;
    }

    if (!conversationResponse.conversation) {
        return;
    }

    const username = conversationResponse.conversation.participant?.name;
    if (!username) {
        return;
    }

    const messagesInConversation = Object.values(conversationResponse.conversation.messages);
    const currentMessage = messagesInConversation.find(message => message.id && event.messageId.includes(message.id));
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
        await handleControlSubredditModmail(username, event.conversationId, currentMessage?.bodyMarkdown, context);
    } else {
        if (conversationResponse.conversation.state === ModMailConversationState.Archived) {
            return;
        }
        await handleClientSubredditModmail(username, event.conversationId, context);
    }
}

async function addSummaryForUser (conversationId: string, username: string, context: TriggerContext) {
    const userSummary = await getSummaryTextForUser(username, context);
    const messageText = userSummary ?? "No summary available, user may be shadowbanned";

    await context.reddit.modMail.reply({
        body: messageText,
        conversationId,
        isInternal: true,
    });
}
