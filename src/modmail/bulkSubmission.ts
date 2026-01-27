import { Comment, Post, TriggerContext } from "@devvit/public-api";
import Ajv, { JSONSchemaType } from "ajv";
import { getUserStatus, UserStatus } from "../dataStore.js";
import _ from "lodash";
import { subMonths } from "date-fns";
import json2md from "json2md";
import { AsyncSubmission, queuePostCreation } from "../postCreation.js";
import { getUserExtended, UserExtended } from "../extendedDevvit.js";
import { CONTROL_SUBREDDIT } from "../constants.js";
import pluralize from "pluralize";
import { EvaluationResult, storeAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import { ModmailMessage } from "./modmail.js";
import { getControlSubSettings } from "../settings.js";

interface UserWithDetails {
    username: string;
    submitter: string;
    reason?: string;
}

interface BulkSubmission {
    usernames?: string[];
    userDetails?: UserWithDetails[];
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
        userDetails: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    username: { type: "string" },
                    submitter: { type: "string" },
                    reason: { type: "string", nullable: true },
                },
                required: ["username", "submitter"],
                additionalProperties: false,
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

async function handleBulkItem (username: string, initialStatus: UserStatus, submitter: string, externalSubmitter: string | undefined, reason: string | undefined, context: TriggerContext): Promise<boolean> {
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
        const overrideStatus = await trustedSubmitterInitialStatus(submitter, user, context);
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
            operator: context.appSlug,
            trackingPostId: "",
        },
        commentToAdd,
        immediate: false,
        evaluatorsChecked: false,
    };

    await queuePostCreation(submission, context);

    if (externalSubmitter) {
        const evaluationResult: EvaluationResult = {
            botName: "Modmail Bulk Submission",
            hitReason: `Submitted via ${submitter} due to report by ${externalSubmitter}`,
            canAutoBan: initialStatus === UserStatus.Banned,
            metThreshold: true,
        };
        await storeAccountInitialEvaluationResults(username, [evaluationResult], context);
    }
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
        const results = await Promise.all(_.uniq(data.usernames).map(username => handleBulkItem(username, initialStatus, submitter, undefined, data.reason, context)));
        queued += _.compact(results).length;
    }

    if (data.userDetails) {
        const initialStatus = trusted ? UserStatus.Banned : UserStatus.Pending;
        const results = await Promise.all(data.userDetails.map(entry => handleBulkItem(entry.username, initialStatus, submitter, entry.submitter, entry.reason ?? data.reason, context)));
        queued += _.compact(results).length;
    }

    await context.reddit.modMail.archiveConversation(conversationId);

    if (queued > 0) {
        console.log(`Bulk submission: Queued ${queued} ${pluralize("user", queued)} for submission.`);
    }

    return true;
}

async function trustedSubmitterInitialStatus (submitter: string, submittedAccount: UserExtended, context: TriggerContext): Promise<UserStatus | undefined> {
    if (submitter !== "HelpfulJanitor") {
        return UserStatus.Banned;
    }

    console.log(`Checking trusted submitter status for ${submittedAccount.username}`);

    if (submittedAccount.commentKarma > 10000 || submittedAccount.linkKarma > 10000 || submittedAccount.createdAt < subMonths(new Date(), 6)) {
        console.log(`Trusted submitter override: ${submittedAccount.username} has high karma or is older than 6 months`);
        return UserStatus.Pending;
    }

    let history: (Post | Comment)[];
    try {
        history = await context.reddit.getCommentsAndPostsByUser({
            username: submittedAccount.username,
            limit: 100,
        }).all();
    } catch {
        return;
    }

    const recentHistory = history.filter(item => item.createdAt > subMonths(new Date(), 3));

    if (recentHistory.some(item => item.edited)) {
        console.log(`Trusted submitter override: ${submittedAccount.username} has edited comments or posts`);
        return UserStatus.Pending;
    }

    const recentComments = recentHistory.filter(item => item instanceof Comment);
    const commentPosts = _.countBy(recentComments.map(comment => comment.postId));
    if (Object.values(commentPosts).some(count => count > 1)) {
        console.log(`Trusted submitter override: ${submittedAccount.username} has commented multiple times in the same post`);
        return UserStatus.Pending;
    }

    return UserStatus.Banned;
}

export async function retryBulkSubmission (modmail: ModmailMessage, context: TriggerContext) {
    const conversation = await context.reddit.modMail.getConversation({ conversationId: modmail.conversationId });
    if (!conversation.conversation) {
        console.log(`Retry bulk submission: Conversation ${modmail.conversationId} not found`);
        return;
    }

    const commandMessage = Object.values(conversation.conversation.messages).find(message => message.bodyMarkdown?.startsWith("{"));
    if (!commandMessage?.bodyMarkdown) {
        console.log(`Retry bulk submission: Command message not found in conversation ${modmail.conversationId}`);
        return;
    }

    if (!commandMessage.author?.name) {
        console.log(`Retry bulk submission: Command message author not found in conversation ${modmail.conversationId}`);
        return;
    }

    const controlSubSettings = await getControlSubSettings(context);
    const isTrusted = controlSubSettings.trustedSubmitters.includes(commandMessage.author.name);

    await handleBulkSubmission(commandMessage.author.name, isTrusted, modmail.conversationId, commandMessage.bodyMarkdown, context);
    console.log(`Retry bulk submission: Retried bulk submission for conversation ${modmail.conversationId}`);
}
