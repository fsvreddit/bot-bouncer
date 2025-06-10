import { Comment, Post, TriggerContext } from "@devvit/public-api";
import Ajv, { JSONSchemaType } from "ajv";
import { getUserStatus, UserStatus } from "../dataStore.js";
import { compact, countBy, uniq } from "lodash";
import { subMonths } from "date-fns";
import json2md from "json2md";
import { AsyncSubmission, queuePostCreation } from "../postCreation.js";
import { getUserExtended, UserExtended } from "../extendedDevvit.js";
import { CONTROL_SUBREDDIT } from "../constants.js";
import pluralize from "pluralize";

interface BulkSubmission {
    usernames?: string[];
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
            nullable: true,
        },
        reason: {
            type: "string",
            nullable: true,
        },
    },
    additionalProperties: false,
};

async function handleBulkItem (username: string, initialStatus: UserStatus, submitter: string, reason: string | undefined, context: TriggerContext): Promise<boolean> {
    const user = await getUserExtended(username, context);
    if (!user) {
        console.log(`Bulk submission: User ${username} is deleted or shadowbanned, skipping.`);
        return false;
    }

    const currentStatus = await getUserStatus(username, context);
    if (currentStatus) {
        console.log(`Bulk submission: User ${username} already has a status of ${currentStatus.userStatus}.`);
        return false;
    }

    if (initialStatus === UserStatus.Banned) {
        const overrideStatus = await trustedSubmitterInitialStatus(user, context);
        if (overrideStatus && initialStatus !== overrideStatus) {
            initialStatus = overrideStatus;
        }
    }

    let commentToAdd: string | undefined;
    if (reason) {
        commentToAdd = json2md([
            { p: "The submitter added the following context for this submission:" },
            { blockquote: reason },
            { p: `*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you have any questions or concerns.*` },
        ]);
    }

    const submission: AsyncSubmission = {
        user,
        details: {
            userStatus: initialStatus,
            lastUpdate: new Date().getTime(),
            submitter,
            operator: context.appName,
            trackingPostId: "",
        },
        commentToAdd,
        immediate: false,
    };

    await queuePostCreation(submission, context);
    return true;
}

export async function handleBulkSubmission (submitter: string, trusted: boolean, conversationId: string, message: string, context: TriggerContext): Promise<boolean> {
    console.log(`Bulk submission: New submission from ${submitter}`);
    let data: BulkSubmission;
    try {
        data = JSON.parse(message) as BulkSubmission;
    } catch (error) {
        await context.reddit.modMail.reply({
            conversationId,
            body: json2md([
                { p: "Error parsing JSON" },
                { blockquote: error },
            ]),
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
            body: json2md([
                { p: "Invalid JSON" },
                { blockquote: ajv.errorsText(validate.errors) },
            ]),
            isAuthorHidden: false,
        });
        await context.reddit.modMail.archiveConversation(conversationId);
        return false;
    }

    let queued = 0;

    if (data.usernames) {
        const initialStatus = trusted ? UserStatus.Banned : UserStatus.Pending;
        const results = await Promise.all(uniq(data.usernames).map(username => handleBulkItem(username, initialStatus, submitter, data.reason, context)));
        queued += compact(results).length;
    }

    await context.reddit.modMail.archiveConversation(conversationId);

    if (queued > 0) {
        console.log(`Bulk submission: Queued ${queued} ${pluralize("user", queued)} for submission.`);
    }

    return true;
}

async function trustedSubmitterInitialStatus (user: UserExtended, context: TriggerContext): Promise<UserStatus | undefined> {
    console.log(`Checking trusted submitter status for ${user.username}`);

    if (user.commentKarma > 10000 || user.linkKarma > 10000 || user.createdAt < subMonths(new Date(), 6)) {
        console.log(`Trusted submitter override: ${user.username} has high karma or is older than 6 months`);
        return UserStatus.Pending;
    }

    let history: (Post | Comment)[];
    try {
        history = await context.reddit.getCommentsAndPostsByUser({
            username: user.username,
            limit: 100,
        }).all();
    } catch {
        return;
    }

    const recentHistory = history.filter(item => item.createdAt > subMonths(new Date(), 3));

    if (recentHistory.some(item => item.edited)) {
        console.log(`Trusted submitter override: ${user.username} has edited comments or posts`);
        return UserStatus.Pending;
    }

    const recentComments = recentHistory.filter(item => item instanceof Comment);
    const commentPosts = countBy(recentComments.map(comment => comment.postId));
    if (Object.values(commentPosts).some(count => count > 1)) {
        console.log(`Trusted submitter override: ${user.username} has commented multiple times in the same post`);
        return UserStatus.Pending;
    }

    return UserStatus.Banned;
}
