import { TriggerContext } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { wasUserBannedByApp } from "../handleClientSubredditClassificationChanges.js";
import { isBanned, replaceAll } from "../utility.js";
import { CONFIGURATION_DEFAULTS } from "../settings.js";
import { ModmailMessage } from "./modmail.js";

export async function handleClientSubredditModmail (modmail: ModmailMessage, context: TriggerContext) {
    if (!modmail.isFirstMessage) {
        return;
    }

    const username = modmail.participant;
    if (!username) {
        return;
    }

    if (modmail.messageAuthor !== modmail.participant) {
        return;
    }

    const currentStatus = await getUserStatus(username, context);

    if (!currentStatus || currentStatus.userStatus !== UserStatus.Banned) {
        return;
    }

    const bannedByApp = await wasUserBannedByApp(username, context);
    if (!bannedByApp) {
        return;
    }

    const userIsBanned = await isBanned(username, context);
    if (!userIsBanned) {
        return;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const post = await context.reddit.getPostById(currentStatus.trackingPostId);

    let message = CONFIGURATION_DEFAULTS.noteClient;
    message = replaceAll(message, "{link}", post.permalink);
    message = replaceAll(message, "{subreddit}", subredditName);
    message = replaceAll(message, "{account}", username);

    await context.reddit.modMail.reply({
        body: message,
        conversationId: modmail.conversationId,
        isInternal: true,
    });
}
