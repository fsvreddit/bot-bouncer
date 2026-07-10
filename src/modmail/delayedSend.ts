import { JobContext, JSONObject, ScheduledJobEvent, TriggerContext } from "@devvit/public-api";
import { addDays, addMinutes, addSeconds } from "date-fns";
import json2md from "json2md";
import { ControlSubredditJob } from "../constants.js";

interface DelayedMessageOptions {
    id?: string;
    conversationId: string;
    message: string;
    sendAt: Date;
    archive?: boolean;
}

const DELAYED_MESSAGE_QUEUE = "delayedMessageQueue";

function createDelayedMessageId (conversationId: string): string {
    return `${conversationId}:${Date.now()}:${Math.random()}`;
}

function getReplySentKey (messageId: string): string {
    return `delayedMessageReplySent~${messageId}`;
}

function legacyMessageId (member: string): string {
    let hash = 2166136261;
    for (let index = 0; index < member.length; index++) {
        hash ^= member.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `legacy:${(hash >>> 0).toString(36)}`;
}

export async function sendMessageOnDelay (context: TriggerContext, params: DelayedMessageOptions) {
    if (params.sendAt <= addSeconds(new Date(), 10)) {
        await context.reddit.modMail.reply({
            conversationId: params.conversationId,
            isAuthorHidden: true,
            body: params.message,
        });

        if (params.archive) {
            await context.reddit.modMail.archiveConversation(params.conversationId);
        }

        return;
    }

    const queuedMessage: DelayedMessageOptions = {
        ...params,
        id: params.id ?? createDelayedMessageId(params.conversationId),
    };
    await context.redis.zAdd(DELAYED_MESSAGE_QUEUE, { member: JSON.stringify(queuedMessage), score: params.sendAt.getTime() });

    if (params.sendAt > addMinutes(new Date(), 1)) {
        const privateReplyMessage: json2md.DataObject[] = [
            { p: `A message is scheduled to be sent at ${params.sendAt.toUTCString()}.` },
            { p: "Message preview:" },
            { blockquote: params.message },
        ];

        await context.reddit.modMail.reply({
            conversationId: params.conversationId,
            isInternal: true,
            body: json2md(privateReplyMessage),
        });
    }
}

export async function processDelayedMessages (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const recentlyRunKey = "processDelayedMessagesRecentlyRun";
    if (event.data?.firstRun && await context.redis.exists(recentlyRunKey)) {
        return;
    }

    await context.redis.set(recentlyRunKey, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });

    const queuedMessages = await context.redis.zRange(DELAYED_MESSAGE_QUEUE, 0, Date.now(), { by: "score" });

    if (queuedMessages.length === 0) {
        return;
    }

    const queuedMember = queuedMessages[0].member;
    const firstMessage = JSON.parse(queuedMember) as DelayedMessageOptions;
    const replySentKey = getReplySentKey(firstMessage.id ?? legacyMessageId(queuedMember));

    if (!await context.redis.exists(replySentKey)) {
        await context.reddit.modMail.reply({
            conversationId: firstMessage.conversationId,
            isAuthorHidden: true,
            body: firstMessage.message,
        });
        await context.redis.set(replySentKey, Date.now().toString(), { expiration: addDays(new Date(), 28) });
    }

    if (firstMessage.archive) {
        await context.reddit.modMail.archiveConversation(firstMessage.conversationId);
    }

    await context.redis.zRem(DELAYED_MESSAGE_QUEUE, [queuedMember]);

    if (queuedMessages.length > 1) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.ProcessDelayedMessages,
            data: { firstRun: false },
            runAt: addSeconds(new Date(), 5),
        });
    } else {
        await context.redis.del(recentlyRunKey);
    }

    console.log(`Delayed Messages: Processed message for conversation ${firstMessage.conversationId}`);
}

export async function areAnyDelayedMessagesQueued (context: JobContext) {
    const queuedMessages = await context.redis.zRange(DELAYED_MESSAGE_QUEUE, 0, Date.now(), { by: "score" });
    return queuedMessages.length > 0;
}
