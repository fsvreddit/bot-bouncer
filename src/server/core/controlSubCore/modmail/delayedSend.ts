import { reddit, redis, scheduler, TaskRequest } from "@devvit/web/server";
import { addMinutes, addSeconds } from "date-fns";
import json2md from "json2md";
import { DelayedMessageJobData } from "../../../tasks";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { ControlSubredditJob } from "../..";

interface DelayedMessageOptions {
    conversationId: string;
    message: string;
    sendAt: Date;
    archive?: boolean;
}

const DELAYED_MESSAGE_QUEUE = "delayedMessageQueue";

export async function sendMessageOnDelay (params: DelayedMessageOptions) {
    if (params.sendAt <= addSeconds(new Date(), 10)) {
        await reddit.modMail.reply({
            conversationId: params.conversationId,
            isAuthorHidden: true,
            body: params.message,
        });

        if (params.archive) {
            await reddit.modMail.archiveConversation(params.conversationId);
        }

        return;
    }

    await redis.zAdd(DELAYED_MESSAGE_QUEUE, { member: JSON.stringify(params), score: params.sendAt.getTime() });

    if (params.sendAt > addMinutes(new Date(), 1)) {
        const privateReplyMessage: json2md.DataObject[] = [
            { p: `A message is scheduled to be sent at ${params.sendAt.toUTCString()}.` },
            { p: "Message preview:" },
            { blockquote: params.message },
        ];

        await reddit.modMail.reply({
            conversationId: params.conversationId,
            isInternal: true,
            body: json2md(privateReplyMessage),
        });
    }
}

export async function processDelayedMessages (event: TaskRequest<DelayedMessageJobData>) {
    const jobGuid = event.data.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Process Delayed Messages: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const recentlyRunKey = "processDelayedMessagesRecentlyRun";
    if (event.data.firstRun && await redis.exists(recentlyRunKey)) {
        return;
    }

    await redis.set(recentlyRunKey, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });

    const queuedMessages = await redis.zRange(DELAYED_MESSAGE_QUEUE, 0, Date.now(), { by: "score" });

    const firstEntry = queuedMessages[0];
    if (!firstEntry) {
        return;
    }

    const firstMessage = JSON.parse(firstEntry.member) as DelayedMessageOptions;
    await redis.zRem(DELAYED_MESSAGE_QUEUE, [firstEntry.member]);

    await reddit.modMail.reply({
        conversationId: firstMessage.conversationId,
        isAuthorHidden: true,
        body: firstMessage.message,
    });

    if (firstMessage.archive) {
        await reddit.modMail.archiveConversation(firstMessage.conversationId);
    }

    if (queuedMessages.length > 1) {
        await scheduler.runJob<DelayedMessageJobData>({
            name: ControlSubredditJob.ProcessDelayedMessages,
            data: { firstRun: false, jobGuid: crypto.randomUUID() },
            runAt: addSeconds(new Date(), 5),
        });
    } else {
        await redis.del(recentlyRunKey);
    }

    console.log(`Delayed Messages: Processed message for conversation ${firstMessage.conversationId}`);
}

export async function areAnyDelayedMessagesQueued () {
    const queuedMessages = await redis.zRange(DELAYED_MESSAGE_QUEUE, 0, Date.now(), { by: "score" });
    return queuedMessages.length > 0;
}
