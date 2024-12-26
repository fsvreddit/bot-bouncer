import { GetConversationResponse, ModMailConversationState, TriggerContext, User } from "@devvit/public-api";
import { ModMail } from "@devvit/protos";
import { addMonths } from "date-fns";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { wasUserBannedByApp } from "./handleClientSubredditWikiUpdate.js";
import { isBanned, replaceAll } from "./utility.js";
import { CONFIGURATION_DEFAULTS } from "./settings.js";

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
        if (conversationResponse.conversation.state === ModMailConversationState.Archived) {
            return;
        }
        messageSent = await handleClientSubredditModmail(username, event.conversationId, context);
    }

    if (messageSent) {
        await setConversationHandled(event.conversationId, context);
    }
}

async function handleControlSubredditModmail (username: string, conversationId: string, context: TriggerContext): Promise<boolean> {
    const currentStatus = await getUserStatus(username, context);

    if (!currentStatus || currentStatus.userStatus === UserStatus.Pending) {
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

    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(username);
    } catch {
        //
    }

    if (currentStatus.userStatus === UserStatus.Banned) {
        const message = user ? CONFIGURATION_DEFAULTS.appealMessage : CONFIGURATION_DEFAULTS.appealShadowbannedMessage;

        await context.reddit.modMail.reply({
            body: message,
            conversationId,
            isInternal: false,
            isAuthorHidden: false,
        });

        if (!user) {
            await context.reddit.modMail.archiveConversation(conversationId);
        }
    }

    return true;
}

async function handleClientSubredditModmail (username: string, conversationId: string, context: TriggerContext): Promise<boolean> {
    const currentStatus = await getUserStatus(username, context);

    const conversation = await context.reddit.modMail.getConversation({ conversationId });
    const currentState = conversation.conversation?.state;

    if (!currentStatus || currentStatus.userStatus === UserStatus.Pending) {
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

    if (currentState === ModMailConversationState.Archived) {
        await context.reddit.modMail.archiveConversation(conversationId);
    }

    return true;
}
