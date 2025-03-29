import { TriggerContext } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { getSummaryTextForUser } from "../UserSummary/userSummary.js";
import { getUserOrUndefined } from "../utility.js";
import { CONFIGURATION_DEFAULTS, getControlSubSettings } from "../settings.js";
import { handleBulkSubmission } from "./bulkSubmission.js";

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

    const post = await context.reddit.getPostById(currentStatus.trackingPostId);

    let message = `/u/${username} is currently listed as ${currentStatus.userStatus}, set by ${currentStatus.operator} at ${new Date(currentStatus.lastUpdate).toUTCString()} and reported by ${currentStatus.submitter ?? "unknown"}\n\n`;
    message += `[Link to submission](${post.permalink})`;

    if (currentStatus.userStatus === UserStatus.Banned || currentStatus.userStatus === UserStatus.Purged) {
        const userSummary = await getSummaryTextForUser(username, context);
        if (userSummary) {
            message += `\n\n${userSummary}`;
        }
    }

    await context.reddit.modMail.reply({
        body: message,
        conversationId,
        isInternal: true,
    });

    const user = await getUserOrUndefined(username, context);

    if (currentStatus.userStatus === UserStatus.Banned || currentStatus.userStatus === UserStatus.Purged) {
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
