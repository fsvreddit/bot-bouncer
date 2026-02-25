import { JobContext, TriggerContext } from "@devvit/public-api";
import { addSeconds } from "date-fns";
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

export async function processDelayedMessages (context: JobContext) {
    const queuedMessages = await context.redis.zRange(DELAYED_MESSAGE_QUEUE, 0, Date.now(), { by: "score" });

    if (queuedMessages.length === 0) {
        return;
    }

    const firstMessage = JSON.parse(queuedMessages[0].member) as DelayedMessageOptions;
    await context.redis.zRem(DELAYED_MESSAGE_QUEUE, [queuedMessages[0].member]);

    await context.reddit.modMail.reply({
        conversationId: firstMessage.conversationId,
        isAuthorHidden: true,
        body: firstMessage.message,
    });

    if (firstMessage.archive) {
        await context.reddit.modMail.archiveConversation(firstMessage.conversationId);
    }

    console.log(`Delayed Messages: Processed message for conversation ${firstMessage.conversationId}`);
}
