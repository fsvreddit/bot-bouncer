import { TriggerContext } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { wasUserBannedByApp } from "../handleClientSubredditClassificationChanges.js";
import { CONFIGURATION_DEFAULTS } from "../settings.js";
import { ModmailMessage } from "./modmail.js";
import { isBanned } from "devvit-helpers";

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

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    const userIsBanned = await isBanned(context.reddit, subredditName, username);
    if (!userIsBanned) {
        return;
    }

    const post = await context.reddit.getPostById(currentStatus.trackingPostId);

    const message = CONFIGURATION_DEFAULTS.noteClient
        .replaceAll("{link}", post.permalink)
        .replaceAll("{subreddit}", subredditName)
        .replaceAll("{account}", username);

    await context.reddit.modMail.reply({
        body: message,
        conversationId: modmail.conversationId,
        isInternal: true,
    });
}
