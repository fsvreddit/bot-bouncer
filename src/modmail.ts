import { GetConversationResponse, TriggerContext } from "@devvit/public-api";
import { ModMail } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getUserStatus, UserStatus, wasUserBannedByApp } from "./dataStore.js";
import { isBanned, replaceAll } from "./utility.js";
import { CONFIGURATION_DEFAULTS } from "./settings.js";

const CONVERSATION_STORE = "ConversationStore";

export async function getConversationHandled (conversationId: string, context: TriggerContext) {
    const handled = await context.redis.hGet(CONVERSATION_STORE, conversationId);
    return handled === "true";
}

export async function setConversationHandled (conversationId: string, context: TriggerContext) {
    await context.redis.hSet(CONVERSATION_STORE, { [conversationId]: "true" });
}

export async function handleModmail (event: ModMail, context: TriggerContext) {
    const conversationHandled = await getConversationHandled(event.conversationId, context);
    if (conversationHandled) {
        return;
    }

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

    let messageSent: boolean;

    if (context.subredditName === CONTROL_SUBREDDIT) {
        messageSent = await handleControlSubredditModmail(username, event.conversationId, context);
    } else {
        messageSent = await handleClientSubredditModmail(username, event.conversationId, context);
    }

    if (messageSent) {
        await setConversationHandled(event.conversationId, context);
    }
}

async function handleControlSubredditModmail (username: string, conversationId: string, context: TriggerContext): Promise<boolean> {
    const currentStatus = await getUserStatus(username, context);

    if (!currentStatus) {
        return false;
    }

    const post = await context.reddit.getPostById(currentStatus.trackingPostId);

    let message = `/u/${username} is currently listed as ${currentStatus.userStatus}, set by ${currentStatus.operator} at ${new Date(currentStatus.lastUpdate).toUTCString()}\n\n`;
    message += `[Link to submission](${post.permalink})`;

    await context.reddit.modMail.reply({
        body: message,
        conversationId,
        isInternal: true,
    });

    if (currentStatus.userStatus === UserStatus.Banned) {
        await context.reddit.modMail.reply({
            body: CONFIGURATION_DEFAULTS.appealMessage,
            conversationId,
            isInternal: false,
            isAuthorHidden: false,
        });
    }

    return true;
}

async function handleClientSubredditModmail (username: string, conversationId: string, context: TriggerContext): Promise<boolean> {
    const currentStatus = await getUserStatus(username, context);

    if (!currentStatus) {
        return false;
    }

    const bannedByApp = await wasUserBannedByApp(username, context);
    if (!bannedByApp) {
        return false;
    }

    const userIsBanned = await isBanned(username, context);
    if (!userIsBanned) {
        return false;
    }

    const subredditName = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;
    const post = await context.reddit.getPostById(currentStatus.trackingPostId);

    let message = CONFIGURATION_DEFAULTS.noteClient;
    message = replaceAll(message, "{link}", post.permalink);
    message = replaceAll(message, "{subreddit}", subredditName);
    message = replaceAll(message, "{account}", username);

    await context.reddit.modMail.reply({
        body: message,
        conversationId,
        isInternal: true,
    });

    return true;
}
