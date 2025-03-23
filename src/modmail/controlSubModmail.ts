import { Post, Comment, TriggerContext } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { getSummaryTextForUser } from "../UserSummary/userSummary.js";
import { getUserOrUndefined } from "../utility.js";
import { CONFIGURATION_DEFAULTS, getControlSubSettings } from "../settings.js";
import Ajv, { JSONSchemaType } from "ajv";
import { EXTERNAL_SUBMISSION_QUEUE, ExternalSubmission, scheduleAdhocExternalSubmissionsJob } from "../externalSubmissions.js";
import { countBy, uniq } from "lodash";
import { subMonths } from "date-fns";

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

interface BulkSubmission {
    usernames: string[];
    reason?: string;
}

const schema: JSONSchemaType<BulkSubmission> = {
    type: "object",
    properties: {
        usernames: {
            type: "array",
            items: {
                type: "string",
            },
        },
        reason: {
            type: "string",
            nullable: true,
        },
    },
    required: ["usernames"],
    additionalProperties: false,
};

async function handleBulkSubmission (username: string, trusted: boolean, conversationId: string, message: string, context: TriggerContext): Promise<boolean> {
    let data: BulkSubmission;
    try {
        data = JSON.parse(message) as BulkSubmission;
    } catch (error) {
        await context.reddit.modMail.reply({
            conversationId,
            body: `Error parsing JSON:\n\n${error}`,
            isAuthorHidden: false,
        });
        await context.reddit.modMail.archiveConversation(conversationId);
        return false;
    }

    const ajv = new Ajv.default();
    const validate = ajv.compile(schema);

    if (!validate(data)) {
        await context.reddit.modMail.reply({
            conversationId,
            body: `Invalid JSON:\n\n${ajv.errorsText(validate.errors)}`,
            isAuthorHidden: false,
        });
        await context.reddit.modMail.archiveConversation(conversationId);
        return false;
    }

    const initialStatus = trusted ? UserStatus.Banned : UserStatus.Pending;
    const externalSubmissions = uniq(data.usernames).map(botUsername => ({ username: botUsername, reportContext: data.reason, submitter: username, initialStatus } as ExternalSubmission));

    let queued = 0;

    for (const entry of externalSubmissions) {
        const currentStatus = await getUserStatus(entry.username, context);
        if (currentStatus) {
            continue;
        }

        if (entry.initialStatus === UserStatus.Banned) {
            const overrideStatus = await trustedSubmitterInitialStatus(entry.username, context);
            if (!overrideStatus) {
                continue;
            }
            if (entry.initialStatus !== overrideStatus) {
                console.log(`Trusted submitter override: ${entry.username} has been set to ${overrideStatus}`);
                entry.initialStatus = overrideStatus;
            }
            entry.initialStatus = overrideStatus;
        }

        queued++;
        await context.redis.hSet(EXTERNAL_SUBMISSION_QUEUE, { [entry.username]: JSON.stringify(entry) });
    }

    await context.reddit.modMail.archiveConversation(conversationId);

    if (queued > 0) {
        await scheduleAdhocExternalSubmissionsJob(context);
    }

    return true;
}

async function trustedSubmitterInitialStatus (username: string, context: TriggerContext): Promise<UserStatus | undefined> {
    const user = await getUserOrUndefined(username, context);
    if (!user) {
        return;
    }

    console.log(`Checking trusted submitter status for ${username}`);

    if (user.commentKarma > 10000 || user.linkKarma > 10000 || user.createdAt < subMonths(new Date(), 6)) {
        console.log(`Trusted submitter override: ${username} has high karma or is older than 6 months`);
        return UserStatus.Pending;
    }

    let history: (Post | Comment)[];
    try {
        history = await context.reddit.getCommentsAndPostsByUser({
            username,
            limit: 100,
        }).all();
    } catch {
        return;
    }

    const recentHistory = history.filter(item => item.createdAt > subMonths(new Date(), 3));

    if (recentHistory.some(item => item.edited)) {
        console.log(`Trusted submitter override: ${username} has edited comments or posts`);
        return UserStatus.Pending;
    }

    const recentComments = recentHistory.filter(item => item instanceof Comment) as Comment[];
    const commentPosts = countBy(recentComments.map(comment => comment.postId));
    if (Object.values(commentPosts).some(count => count > 1)) {
        console.log(`Trusted submitter override: ${username} has commented multiple times in the same post`);
        return UserStatus.Pending;
    }

    return UserStatus.Banned;
}
