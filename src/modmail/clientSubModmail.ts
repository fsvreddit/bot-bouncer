import { TriggerContext } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { wasUserBannedByApp } from "../handleClientSubredditClassificationChanges.js";
import { AppSetting, CONFIGURATION_DEFAULTS } from "../settings.js";
import { ModmailMessage } from "./modmail.js";
import { isBanned } from "devvit-helpers";
import json2md from "json2md";

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

    if (currentStatus?.userStatus !== UserStatus.Banned) {
        return;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    const userIsBanned = await isBanned(context.reddit, subredditName, username);
    if (!userIsBanned) {
        if (await context.settings.get<boolean>(AppSetting.AddModmailIfNotBannedYet)) {
            const message: json2md.DataObject[] = [
                { p: `For info: User /u/${username} is currently listed on /r/${subredditName} as a bot or botlike account, but they aren't currently banned on /r/${subredditName}.` },
                { p: `*I am a bot, and this action was performed automatically. To turn off this notification in the future, please adjust your settings.*` },
            ];

            await context.reddit.modMail.reply({
                conversationId: modmail.conversationId,
                body: json2md(message),
                isInternal: true,
            });
        }
        return;
    }

    const bannedByApp = await wasUserBannedByApp(username, context);
    if (!bannedByApp) {
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
