import { JobContext, TriggerContext } from "@devvit/public-api";
import { addMinutes, addSeconds } from "date-fns";
import json2md from "json2md";

interface DelayedMessageOptions {
    conversationId: string;
    message: string;
    sendAt: Date;
    archive?: boolean;
}

const DELAYED_MESSAGE_QUEUE = "delayedMessageQueue";

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

export async function processDelayedMessages (context: JobContext) {
    const queuedMessages = await context.redis.zRange(DELAYED_MESSAGE_QUEUE, 0, Date.now(), { by: "score" });

    if (queuedMessages.length === 0) {
        return;
    }

    for (const queuedMessage of queuedMessages) {
        let messageData: DelayedMessageOptions;
        try {
            messageData = JSON.parse(queuedMessage.member) as DelayedMessageOptions;
        } catch (error) {
            console.error("Delayed Messages: Failed to parse queued message, removing entry.", error);
            await context.redis.zRem(DELAYED_MESSAGE_QUEUE, [queuedMessage.member]);
            continue;
        }

        try {
            await context.reddit.modMail.reply({
                conversationId: messageData.conversationId,
                isAuthorHidden: true,
                body: messageData.message,
            });

            if (messageData.archive) {
                await context.reddit.modMail.archiveConversation(messageData.conversationId);
            }

            await context.redis.zRem(DELAYED_MESSAGE_QUEUE, [queuedMessage.member]);
            console.log(`Delayed Messages: Processed message for conversation ${messageData.conversationId}`);
        } catch (error) {
            console.error(`Delayed Messages: Failed processing message for conversation ${messageData.conversationId}.`, error);
        }
    }
}
