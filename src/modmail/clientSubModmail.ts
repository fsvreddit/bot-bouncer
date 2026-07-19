import type { TriggerContext } from "@devvit/public-api";
import { addMinutes, addMonths } from "date-fns";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { wasUserBannedByApp } from "../handleClientSubredditClassificationChanges.js";
import { AppSetting, CONFIGURATION_DEFAULTS } from "../settings.js";
import type { ModmailMessage } from "./modmail.js";
import { isBanned } from "devvit-helpers";
import json2md from "json2md";

const CLIENT_MODMAIL_NOTE_LOCK_PREFIX = "clientModmailNoteLock";
const CLIENT_MODMAIL_NOTE_SENT_PREFIX = "clientModmailNoteSent";

export async function handleClientSubredditModmail (modmail: ModmailMessage, context: TriggerContext) {
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

            await addInternalNoteOnce(modmail.conversationId, json2md(message), context);
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

    await addInternalNoteOnce(modmail.conversationId, message, context);
}

async function addInternalNoteOnce (conversationId: string, body: string, context: TriggerContext) {
    const noteSentKey = `${CLIENT_MODMAIL_NOTE_SENT_PREFIX}:${conversationId}`;
    if (await context.redis.exists(noteSentKey)) {
        return;
    }

    const noteLockKey = `${CLIENT_MODMAIL_NOTE_LOCK_PREFIX}:${conversationId}`;
    const lockAcquired = await context.redis.set(noteLockKey, "true", {
        nx: true,
        expiration: addMinutes(new Date(), 5),
    });
    if (!lockAcquired) {
        return;
    }

    try {
        // Another invocation may have completed between the initial check and this lock being acquired.
        if (await context.redis.exists(noteSentKey)) {
            return;
        }

        await context.reddit.modMail.reply({
            body,
            conversationId,
            isInternal: true,
        });

        await context.redis.set(noteSentKey, "true", { expiration: addMonths(new Date(), 6) });
    } finally {
        await context.redis.del(noteLockKey);
    }
}
