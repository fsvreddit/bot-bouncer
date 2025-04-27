import { TriggerContext } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { getSummaryForUser } from "../UserSummary/userSummary.js";
import { getUserOrUndefined } from "../utility.js";
import { CONFIGURATION_DEFAULTS, getControlSubSettings } from "../settings.js";
import { handleBulkSubmission } from "./bulkSubmission.js";
import { addDays } from "date-fns";
import json2md from "json2md";

export async function handleControlSubredditModmail (username: string, conversationId: string, isFirstMessage: boolean, message: string | undefined, context: TriggerContext): Promise<boolean> {
    const controlSubSettings = await getControlSubSettings(context);

    if (controlSubSettings.bulkSubmitters?.includes(username) && message?.startsWith("{")) {
        const isTrusted = controlSubSettings.trustedSubmitters.includes(username);
        return handleBulkSubmission(username, isTrusted, conversationId, message, context);
    } else if (isFirstMessage) {
        return handleModmailFromUser(username, conversationId, context);
    } else {
        return false;
    }
}

async function handleModmailFromUser (username: string, conversationId: string, context: TriggerContext): Promise<boolean> {
    const currentStatus = await getUserStatus(username, context);

    if (!currentStatus || currentStatus.userStatus === UserStatus.Pending) {
        return false;
    }

    const recentAppealKey = `recentAppeal~${username}`;
    const recentAppealMade = await context.redis.get(recentAppealKey);

    if (recentAppealMade) {
        // User has already made an appeal recently, so we should tell the user it's already being handled.
        await context.reddit.modMail.reply({
            body: CONFIGURATION_DEFAULTS.recentAppealMade,
            conversationId,
            isInternal: false,
            isAuthorHidden: false,
        });
        await context.reddit.modMail.archiveConversation(conversationId);
        return true;
    }

    const post = await context.reddit.getPostById(currentStatus.trackingPostId);

    const message: json2md.DataObject[] = [
        { p: `/u/${username} is currently listed as ${currentStatus.userStatus}, set by ${currentStatus.operator} at ${new Date(currentStatus.lastUpdate).toUTCString()} and reported by ${currentStatus.submitter ?? "unknown"}` },
        { link: { title: "Link to submission", source: `https://www.reddit.com${post.permalink}` } },
    ];

    if (currentStatus.userStatus === UserStatus.Banned || currentStatus.userStatus === UserStatus.Purged) {
        const userSummary = await getSummaryForUser(username, "modmail", context);
        if (userSummary) {
            message.push(userSummary);
        }
    }

    await context.reddit.modMail.reply({
        body: json2md(message),
        conversationId,
        isInternal: true,
    });

    if (currentStatus.userStatus !== UserStatus.Banned && currentStatus.userStatus !== UserStatus.Purged) {
        // User is not banned or purged, so we should not send the "Appeal Received" message.
        return true;
    }

    const user = await getUserOrUndefined(username, context);
    if (!user) {
        // User is not found, so we should not send the "Appeal Received" message.
        await context.reddit.modMail.reply({
            body: CONFIGURATION_DEFAULTS.appealShadowbannedMessage,
            conversationId,
            isInternal: false,
            isAuthorHidden: false,
        });
        await context.reddit.modMail.archiveConversation(conversationId);
        return true;
    }

    await context.reddit.modMail.reply({
        body: CONFIGURATION_DEFAULTS.appealMessage,
        conversationId,
        isInternal: false,
        isAuthorHidden: false,
    });

    await context.redis.set(recentAppealKey, new Date().getTime().toString(), { expiration: addDays(new Date(), 1) });

    return true;
}
