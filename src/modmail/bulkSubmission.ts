import { Comment, Post, TriggerContext } from "@devvit/public-api";
import Ajv, { JSONSchemaType } from "ajv";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { countBy, uniq } from "lodash";
import { EXTERNAL_SUBMISSION_QUEUE, ExternalSubmission, getExternalSubmissionDataKey, scheduleAdhocExternalSubmissionsJob } from "../externalSubmissions.js";
import { getUserOrUndefined } from "../utility.js";
import { subMonths } from "date-fns";

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

export async function handleBulkSubmission (username: string, trusted: boolean, conversationId: string, message: string, context: TriggerContext): Promise<boolean> {
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
        await context.redis.set(getExternalSubmissionDataKey(entry.username), JSON.stringify(entry));
        await context.redis.zAdd(EXTERNAL_SUBMISSION_QUEUE, { member: entry.username, score: new Date().getTime() });
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
