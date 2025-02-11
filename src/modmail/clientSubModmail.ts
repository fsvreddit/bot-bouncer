import { ModMailConversationState, TriggerContext } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { wasUserBannedByApp } from "../handleClientSubredditWikiUpdate.js";
import { isBanned, replaceAll } from "../utility.js";
import { CONFIGURATION_DEFAULTS } from "../settings.js";

export async function handleClientSubredditModmail (username: string, conversationId: string, context: TriggerContext): Promise<boolean> {
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
