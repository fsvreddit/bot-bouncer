import { GetConversationResponse, ModMailConversationState, TriggerContext } from "@devvit/public-api";
import { ModMail } from "@devvit/protos";
import { addMonths } from "date-fns";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { getUserStatus, UserStatus } from "./dataStore.js";
import { wasUserBannedByApp } from "./handleClientSubredditWikiUpdate.js";
import { getUserOrUndefined, isBanned, replaceAll } from "./utility.js";
import { CONFIGURATION_DEFAULTS } from "./settings.js";
import { getSummaryTextForUser } from "./UserSummary/userSummary.js";

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
        await handleControlSubredditModmail(username, event.conversationId, context);
    } else {
        if (conversationResponse.conversation.state === ModMailConversationState.Archived) {
            return;
        }
        await handleClientSubredditModmail(username, event.conversationId, context);
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

    const userSummary = await getSummaryTextForUser(username, context);
    if (userSummary) {
        message += `\n\n${userSummary}`;
    }

    await context.reddit.modMail.reply({
        body: message,
        conversationId,
        isInternal: true,
    });

    const user = await getUserOrUndefined(username, context);

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

async function addSummaryForUser (conversationId: string, username: string, context: TriggerContext) {
    const userSummary = await getSummaryTextForUser(username, context);
    const messageText = userSummary ?? "No summary available, user may be shadowbanned";

    await context.reddit.modMail.reply({
        body: messageText,
        conversationId,
        isInternal: true,
    });
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

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
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
