import { context, reddit } from "@devvit/web/server";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { getUserExtended } from "@fsvreddit/fsv-devvit-web-helpers";
import Ajv, { JSONSchemaType } from "ajv";
import { AsyncSubmission, PostCreationQueueResult, queuePostCreation } from "..";
import { CONTROL_SUBREDDIT, getControlSubSettings, getUserStatus, ModmailMessage } from "../..";
import json2md from "json2md";
import markdownEscape from "markdown-escape";
import pluralize from "pluralize";

interface UserWithDetails {
    username: string;
    /**
     * @deprecated submitters are ignored in bulk submissions
     */
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

interface BulkItem {
    username: string;
    initialStatus: UserStatus;
    submitter: string;
    reason?: string;
}

async function handleBulkItems (items: BulkItem[]): Promise<number> {
    const submissions: AsyncSubmission[] = [];

    await Promise.all(items.map(async (item) => {
        const { username, initialStatus, submitter, reason } = item;

        const user = await getUserExtended(username);
        if (!user) {
            console.log(`Bulk submission: User ${username} is deleted or shadowbanned, skipping.`);
            return;
        }

        const currentStatus = await getUserStatus(username);
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

    const results = await queuePostCreation(submissions);

    return results.filter(result => result === PostCreationQueueResult.Queued).length;
}

export async function handleBulkSubmission (submitter: string, trusted: boolean, conversationId: string, message: string): Promise<boolean> {
    const controlSubSettings = await getControlSubSettings();
    if (!controlSubSettings.allowNewSubmissions) {
        console.log(`Bulk submission: New submission from ${submitter} was rejected as new submissions are not currently allowed.`);
        await reddit.modMail.reply({
            conversationId,
            body: json2md([{ p: "Bot Bouncer is not currently accepting new submissions." }]),
            isAuthorHidden: false,
        });
        await reddit.modMail.archiveConversation(conversationId);
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
        await reddit.modMail.reply({
            conversationId,
            body: json2md(reply),
            isAuthorHidden: false,
        });
        await reddit.modMail.archiveConversation(conversationId);
        return false;
    }

    const ajv = new Ajv();
    const validate = ajv.compile(schema);

    if (!validate(data)) {
        await reddit.modMail.reply({
            conversationId,
            body: json2md([
                { p: "Invalid JSON" },
                { blockquote: markdownEscape(ajv.errorsText(validate.errors)) },
            ]),
            isAuthorHidden: false,
        });
        await reddit.modMail.archiveConversation(conversationId);
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
        })));
    }

    if (data.userDetails) {
        const initialStatus = trusted ? UserStatus.Banned : UserStatus.Pending;
        queued = await handleBulkItems(data.userDetails.map(entry => ({
            username: entry.username,
            initialStatus,
            submitter,
            reason: entry.reason,
        })));
    }

    await reddit.modMail.archiveConversation(conversationId);

    if (queued > 0) {
        console.log(`Bulk submission: Queued ${queued} ${pluralize("user", queued)} for submission.`);
    }

    return true;
}

export async function retryBulkSubmission (modmail: ModmailMessage) {
    const conversation = await reddit.modMail.getConversation({ conversationId: modmail.conversationId });
    if (!conversation.conversation) {
        console.log(`Retry bulk submission: Conversation ${modmail.conversationId} not found`);
        return;
    }

    if (!modmail.participant) {
        console.log(`Retry bulk submission: Participant not found in conversation ${modmail.conversationId}`);
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

    const controlSubSettings = await getControlSubSettings();
    const trustedSubmitters = new Set(controlSubSettings.trustedSubmitters.map(entry => entry.toLowerCase()));
    const isTrusted = trustedSubmitters.has(commandMessage.author.name.toLowerCase());

    await handleBulkSubmission(modmail.participant, isTrusted, modmail.conversationId, commandMessage.bodyMarkdown);
    console.log(`Retry bulk submission: Retried bulk submission for conversation ${modmail.conversationId}`);
}
