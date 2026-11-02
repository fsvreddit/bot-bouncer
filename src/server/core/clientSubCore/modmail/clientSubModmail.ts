import { context, reddit, settings } from "@devvit/web/server";
import { T3 } from "@devvit/web/shared";
import { isBanned } from "@fsvreddit/fsv-devvit-web-helpers";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { AppSetting, getUserStatus, ModmailMessage, wasUserBannedByApp } from "../..";
import json2md from "json2md";

export async function handleClientSubredditModmail (modmail: ModmailMessage) {
    if (!modmail.isFirstParticipantReply || !modmail.participant) {
        return;
    }

    const username = modmail.participant;

    const currentStatus = await getUserStatus(username);

    if (currentStatus?.userStatus !== UserStatus.Banned) {
        return;
    }

    const appSettings = await settings.getAll();

    const userIsBanned = await isBanned(context.subredditName, username);
    if (!userIsBanned) {
        if (appSettings[AppSetting.AddModmailIfNotBannedYet]) {
            const message: json2md.DataObject[] = [
                { p: `For info: User /u/${username} is currently listed on /r/${context.subredditName} as a bot or botlike account, but they aren't currently banned on /r/${context.subredditName}.` },
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

    const messageTemplate = appSettings[AppSetting.ModmailNote] as string | undefined;
    if (messageTemplate) {
        const message = messageTemplate
            .replaceAll("{link}", post.permalink)
            .replaceAll("{subreddit}", context.subredditName)
            .replaceAll("{account}", username);

        await reddit.modMail.reply({
            body: message,
            conversationId: modmail.conversationId,
            isInternal: true,
        });
    }

    if (appSettings[AppSetting.RespondToFirstUserReply] && appSettings[AppSetting.RespondToFirstUserReplyMessage]) {
        const messageTemplate = appSettings[AppSetting.RespondToFirstUserReplyMessage] as string;

        const message = messageTemplate
            .replaceAll("{link}", post.permalink)
            .replaceAll("{subreddit}", context.subredditName)
            .replaceAll("{account}", username);

        await reddit.modMail.reply({
            body: message,
            conversationId: modmail.conversationId,
            isAuthorHidden: true,
        });
    }
}
