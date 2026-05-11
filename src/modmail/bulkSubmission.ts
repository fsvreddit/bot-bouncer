import { TriggerContext } from "@devvit/public-api";
import Ajv, { JSONSchemaType } from "ajv";
import { getUserStatus, UserStatus } from "../dataStore.js";
import _ from "lodash";
import json2md from "json2md";
import { AsyncSubmission, queuePostCreation } from "../postCreation.js";
import { getUserExtended } from "../extendedDevvit.js";
import { CONTROL_SUBREDDIT } from "../constants.js";
import pluralize from "pluralize";
import { EvaluationResult, storeAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import { ModmailMessage } from "./modmail.js";
import { getControlSubSettings } from "../settings.js";
import markdownEscape from "markdown-escape";

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
    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.allowNewSubmissions) {
        console.log(`Bulk submission: New submission from ${submitter} was rejected as new submissions are not currently allowed.`);
        await context.reddit.modMail.reply({
            conversationId,
            body: json2md([{ p: "Bot Bouncer is not currently accepting new submissions." }]),
            isAuthorHidden: false,
        });
        await context.reddit.modMail.archiveConversation(conversationId);
        return false;
    }

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

    let queued = 0;

    if (data.usernames) {
        const initialStatus = trusted ? UserStatus.Banned : UserStatus.Pending;
        const results = await Promise.all(_.uniq(data.usernames).map(username => handleBulkItem(username, initialStatus, submitter, undefined, data.reason, context)));
        queued += _.compact(results).length;
    }

    if (data.userDetails) {
        const initialStatus = trusted ? UserStatus.Banned : UserStatus.Pending;
        for (const entry of data.userDetails) {
            await handleBulkItem(entry.username, initialStatus, submitter, entry.submitter, entry.reason ?? data.reason, context);
            queued++;
        }
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
