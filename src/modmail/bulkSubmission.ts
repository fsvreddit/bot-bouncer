import { TriggerContext } from "@devvit/public-api";
import Ajv, { JSONSchemaType } from "ajv";
import { getUserStatus, UserStatus } from "../dataStore.js";
import json2md from "json2md";
import { AsyncSubmission, PostCreationQueueResult, queuePostCreation } from "../postCreation.js";
import { getUserExtended } from "@fsvreddit/fsv-devvit-helpers";
import { CONTROL_SUBREDDIT } from "../constants.js";
import pluralize from "pluralize";
import { ModmailMessage } from "./modmail.js";
import { getControlSubSettings } from "../settings.js";
import markdownEscape from "markdown-escape";
import { AccountReviewScheduleResult, submitAccountForReviewByUsername } from "./accountReview.js";

interface UserWithDetails {
    username: string;
    submitter: string;
    reason?: string;
}

interface ScheduleReviewSubmission {
    usernames: string[];
    days: number;
    reason?: string;
}

interface BulkSubmission {
    usernames?: string[];
    userDetails?: UserWithDetails[];
    reason?: string;

    schedule_review?: ScheduleReviewSubmission;
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
        // eslint-disable-next-line camelcase
        schedule_review: {
            type: "object",
            properties: {
                usernames: {
                    type: "array",
                    items: {
                        type: "string",
                        minLength: 1,
                    },
                    minItems: 1,
                },
                days: {
                    type: "integer",
                    minimum: 1,
                },
                reason: {
                    type: "string",
                    nullable: true,
                },
            },
            required: ["usernames", "days"],
            additionalProperties: false,
            nullable: true,
        },
    },
    additionalProperties: false,
};

interface BulkItem {
    username: string;
    initialStatus: UserStatus;
    submitter: string;
    reason?: string;
}

export interface ScheduleReviewResult {
    username: string;
    result: AccountReviewScheduleResult;
}

function describeScheduleReviewResult (result: AccountReviewScheduleResult): string {
    switch (result) {
        case AccountReviewScheduleResult.UserNotFound:
            return "no existing Bot Bouncer status was found";
        case AccountReviewScheduleResult.MissingTrackingPost:
            return "no tracking post was available";
        case AccountReviewScheduleResult.Scheduled:
            return "scheduled";
        default:
            throw new Error(`Unknown account-review scheduling result: ${result as string}`);
    }
}

export function buildScheduleReviewReply (
    results: ScheduleReviewResult[],
    days: number,
): json2md.DataObject[] {
    const scheduled = results.filter(item => item.result === AccountReviewScheduleResult.Scheduled);
    const skipped = results.filter(item => item.result !== AccountReviewScheduleResult.Scheduled);

    const reply: json2md.DataObject[] = [{
        p: `Scheduled ${scheduled.length} ${pluralize("account review", scheduled.length)} in ${days} ${pluralize("day", days)}.`,
    }];

    if (skipped.length > 0) {
        reply.push({
            p: `Skipped ${skipped.length} ${pluralize("account", skipped.length)}:`,
        });
        reply.push({
            ul: skipped.map(item => `/u/${markdownEscape(item.username)}: ${describeScheduleReviewResult(item.result)}`),
        });
    }

    return reply;
}

async function handleScheduleReviewSubmission (
    submitter: string,
    trusted: boolean,
    conversationId: string,
    scheduleReview: ScheduleReviewSubmission,
    context: TriggerContext,
): Promise<boolean> {
    if (!trusted) {
        console.log(`Schedule review: Rejected request from ${submitter} because they are not a trusted submitter.`);

        await context.reddit.modMail.reply({
            conversationId,
            body: json2md([{
                p: "Only trusted submitters can schedule account reviews.",
            }]),
            isAuthorHidden: false,
        });

        await context.reddit.modMail.archiveConversation(conversationId);
        return false;
    }

    const usernames = [...new Map(scheduleReview.usernames.map(username => [
        username.toLowerCase(),
        username,
    ])).values()];

    const results: ScheduleReviewResult[] = await Promise.all(usernames.map(async username => ({
        username,
        result: await submitAccountForReviewByUsername(
            username,
            submitter,
            scheduleReview.days,
            scheduleReview.reason,
            context,
        ),
    })));

    await context.reddit.modMail.reply({
        conversationId,
        body: json2md(buildScheduleReviewReply(results, scheduleReview.days)),
        isAuthorHidden: false,
    });

    await context.reddit.modMail.archiveConversation(conversationId);

    const scheduledCount = results.filter(item => item.result === AccountReviewScheduleResult.Scheduled).length;

    if (scheduledCount > 0) {
        console.log(`Schedule review: Scheduled ${scheduledCount} ${pluralize("account review", scheduledCount)} from ${submitter}.`);
    }

    return scheduledCount > 0;
}

async function handleBulkItems (items: BulkItem[], context: TriggerContext): Promise<number> {
    const submissions: AsyncSubmission[] = [];

    await Promise.all(items.map(async (item) => {
        const { username, initialStatus, submitter, reason } = item;

        const user = await getUserExtended(username, context);
        if (!user) {
            console.log(`Bulk submission: User ${username} is deleted or shadowbanned, skipping.`);
            return;
        }

        const currentStatus = await getUserStatus(username, context);
        if (currentStatus) {
            console.log(`Bulk submission: User ${username} already has a status of ${currentStatus.userStatus}.`);
            return;
        }

        let commentToAdd: string | undefined;
        if (reason) {
            commentToAdd = json2md([
                { p: "The submitter added the following context for this submission:" },
                { blockquote: reason },
                { p: `*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](/message/compose/?to=/r/${CONTROL_SUBREDDIT}) if you have any questions or concerns.*` },
            ]);
        }

        submissions.push({
            user,
            submitter,
            reportContext: reason,
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
        });
    }));

    const results = await queuePostCreation(submissions, context);

    return results.filter(result => result === PostCreationQueueResult.Queued).length;
}

export async function handleBulkSubmission (submitter: string, trusted: boolean, conversationId: string, message: string, context: TriggerContext): Promise<boolean> {
    console.log(`Bulk submission: New submission from ${submitter}`);
    let data: BulkSubmission;
    try {
        data = JSON.parse(message) as BulkSubmission;
    } catch (error) {
        console.log(`Bulk submission: Error parsing JSON from ${submitter}: ${error}`);
        const reply: json2md.DataObject[] = [{ p: "Error parsing JSON" }];
        if (error instanceof Error) {
            reply.push({ blockquote: markdownEscape(error.message) });
        } else {
            reply.push({ blockquote: JSON.stringify(error) });
        }
        await context.reddit.modMail.reply({
            conversationId,
            body: json2md(reply),
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
                { blockquote: markdownEscape(ajv.errorsText(validate.errors)) },
            ]),
            isAuthorHidden: false,
        });
        await context.reddit.modMail.archiveConversation(conversationId);
        return false;
    }

    const scheduleReview = data.schedule_review;
    if (scheduleReview) {
        return await handleScheduleReviewSubmission(
            submitter,
            trusted,
            conversationId,
            scheduleReview,
            context,
        );
    }

    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.allowNewSubmissions) {
        console.log(`Bulk submission: New submission from ${submitter} was rejected as new submissions are not currently allowed.`);

        await context.reddit.modMail.reply({
            conversationId,
            body: json2md([{
                p: "Bot Bouncer is not currently accepting new submissions.",
            }]),
            isAuthorHidden: false,
        });

        await context.reddit.modMail.archiveConversation(conversationId);
        return false;
    }

    let queued = 0;

    if (data.usernames) {
        const initialStatus = trusted ? UserStatus.Banned : UserStatus.Pending;
        queued = await handleBulkItems(data.usernames.map(username => ({
            username,
            initialStatus,
            submitter,
            reason: data.reason,
        })), context);
    }

    if (data.userDetails) {
        const initialStatus = trusted ? UserStatus.Banned : UserStatus.Pending;
        queued = await handleBulkItems(data.userDetails.map(entry => ({
            username: entry.username,
            initialStatus,
            submitter: entry.submitter,
            reason: entry.reason,
        })), context);
    }

    await context.reddit.modMail.archiveConversation(conversationId);

    if (queued > 0) {
        console.log(`Bulk submission: Queued ${queued} ${pluralize("user", queued)} for submission.`);
    }

    return true;
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
