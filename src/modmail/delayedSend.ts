import { JobContext, JSONObject, ScheduledJobEvent, TriggerContext } from "@devvit/public-api";
import { addMinutes, addSeconds } from "date-fns";
import json2md from "json2md";
import { ControlSubredditJob } from "../constants.js";
import { DelayedMessageCompletionAction, isDelayedMessageCompletionRelevant, runDelayedMessageCompletion } from "./delayedMessageCompletion.js";
import { hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-helpers";

interface DelayedMessageOptions {
    conversationId: string;
    message: string;
    sendAt: Date;
    archive?: boolean;
    completionAction?: DelayedMessageCompletionAction;
}

const DELAYED_MESSAGE_QUEUE = "delayedMessageQueue";

async function deliverDelayedMessage (
    params: DelayedMessageOptions,
    context: TriggerContext | JobContext,
): Promise<void> {
    if (params.completionAction && !await isDelayedMessageCompletionRelevant(params.completionAction, context)) {
        console.log(`Delayed Messages: Skipped obsolete message for conversation ${params.conversationId}`);
        return;
    }

    await context.reddit.modMail.reply({
        conversationId: params.conversationId,
        isAuthorHidden: true,
        body: params.message,
    });

    if (params.archive) {
        await context.reddit.modMail.archiveConversation(params.conversationId);
    }

    if (params.completionAction) {
        await runDelayedMessageCompletion(params.completionAction, context);
    }
}

export async function sendMessageOnDelay (context: TriggerContext, params: DelayedMessageOptions) {
    if (params.sendAt <= addSeconds(new Date(), 10)) {
        await deliverDelayedMessage(params, context);
        return;
    }

    await context.redis.zAdd(DELAYED_MESSAGE_QUEUE, { member: JSON.stringify(params), score: params.sendAt.getTime() });

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
    const jobGuid = event.data?.jobGuid as string | undefined;
    if (jobGuid && await hasTriggerBeenHandled(context.redis, `job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Process Delayed Messages: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const recentlyRunKey = "processDelayedMessagesRecentlyRun";
    if (event.data?.firstRun && await context.redis.exists(recentlyRunKey)) {
        return;
    }

    await context.redis.set(recentlyRunKey, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });

    const queuedMessages = await context.redis.zRange(DELAYED_MESSAGE_QUEUE, 0, Date.now(), { by: "score" });

    if (queuedMessages.length === 0) {
        return;
    }

    const firstMessage = JSON.parse(queuedMessages[0].member) as DelayedMessageOptions;
    await context.redis.zRem(DELAYED_MESSAGE_QUEUE, [queuedMessages[0].member]);

    await deliverDelayedMessage(firstMessage, context);

    if (queuedMessages.length > 1) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.ProcessDelayedMessages,
            data: { firstRun: false, jobGuid: crypto.randomUUID() },
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
