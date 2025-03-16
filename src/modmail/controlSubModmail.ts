import { TriggerContext } from "@devvit/public-api";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { getSummaryTextForUser } from "../UserSummary/userSummary.js";
import { getUserOrUndefined } from "../utility.js";
import { CONFIGURATION_DEFAULTS, getControlSubSettings } from "../settings.js";
import Ajv, { JSONSchemaType } from "ajv";
import { EXTERNAL_SUBMISSION_QUEUE, ExternalSubmission, scheduleAdhocExternalSubmissionsJob } from "../externalSubmissions.js";
import { uniq } from "lodash";

export async function handleControlSubredditModmail (username: string, conversationId: string, message: string | undefined, context: TriggerContext): Promise<boolean> {
    const controlSubSettings = await getControlSubSettings(context);

    if (controlSubSettings.bulkSubmitters?.includes(username) && message?.startsWith("{")) {
        const isTrusted = controlSubSettings.trustedSubmitters.includes(username);
        return handleBulkSubmission(username, isTrusted, conversationId, message, context);
    } else {
        return handleModmailFromUser(username, conversationId, context);
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
        if (!currentStatus) {
            queued++;
            await context.redis.hSet(EXTERNAL_SUBMISSION_QUEUE, { [entry.username]: JSON.stringify(entry) });
        }
    }

    await context.reddit.modMail.archiveConversation(conversationId);

    if (queued > 0) {
        await scheduleAdhocExternalSubmissionsJob(context);
    }

    return true;
}
