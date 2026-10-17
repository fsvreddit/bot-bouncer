import { context, reddit, settings } from "@devvit/web/server";
import { T3 } from "@devvit/web/shared";
import { isBanned } from "@fsvreddit/fsv-devvit-web-helpers";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { AppSetting, CONFIGURATION_DEFAULTS, getUserStatus, ModmailMessage, wasUserBannedByApp } from "../..";
import json2md from "json2md";

export async function handleClientSubredditModmail (modmail: ModmailMessage) {
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

    const currentStatus = await getUserStatus(username);

    if (currentStatus?.userStatus !== UserStatus.Banned) {
        return;
    }

    const subredditName = context.subredditName;

    const userIsBanned = await isBanned(subredditName, username);
    if (!userIsBanned) {
        if (await settings.get<boolean>(AppSetting.AddModmailIfNotBannedYet)) {
            const message: json2md.DataObject[] = [
                { p: `For info: User /u/${username} is currently listed on /r/${subredditName} as a bot or botlike account, but they aren't currently banned on /r/${subredditName}.` },
                { p: `*I am a bot, and this action was performed automatically. To turn off this notification in the future, please adjust your settings.*` },
            ];

            await reddit.modMail.reply({
                conversationId: modmail.conversationId,
                body: json2md(message),
                isInternal: true,
            });
        }
        return;
    }

    const bannedByApp = await wasUserBannedByApp(username);
    if (!bannedByApp) {
        return;
    }

    const post = await reddit.getPostById(currentStatus.trackingPostId as T3);

    const message = CONFIGURATION_DEFAULTS.noteClient
        .replaceAll("{link}", post.permalink)
        .replaceAll("{subreddit}", subredditName)
        .replaceAll("{account}", username);

    await reddit.modMail.reply({
        body: message,
        conversationId: modmail.conversationId,
        isInternal: true,
    });
}
