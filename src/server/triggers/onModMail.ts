import { context, ConversationData, GetConversationResponse, MessageData, reddit } from "@devvit/web/server";
import { OnModMailRequest, TriggerResponse } from "@devvit/web/shared";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import type { Context } from "hono";
import { CONTROL_SUBREDDIT, handleClientSubredditModmail, ModmailMessage } from "../core";
import { handleControlSubredditModmail } from "../core/controlSubCore/modmail";

function getSortedMessages (conversation: ConversationData): MessageData[] {
    return Object.values(conversation.messages).sort((a, b) => {
        const dateA = new Date(a.date ?? Date.now());
        const dateB = new Date(b.date ?? Date.now());
        return dateA.getTime() - dateB.getTime();
    });
}

function normaliseConversationId (conversationId: string): string {
    return "ModmailConversation_" + conversationId.replace(/^ModmailConversation_/i, "");
}

function normaliseMessageId (messageId: string): string {
    return "ModmailMessage_" + messageId.replace(/^ModmailMessage_/i, "");
}

export const onModMail = async (c: Context): Promise<Response> => {
    const event = await c.req.json<OnModMailRequest>();
    if (event.messageAuthor?.name === context.appSlug) {
        return c.json<TriggerResponse>({ message: "Ignored message from the app itself" }, 200);
    }

    console.log(`Modmail: ${event.conversationId} (${normaliseConversationId(event.conversationId)}), ${event.messageId} (${normaliseMessageId(event.messageId)})`);

    let conversationResponse: GetConversationResponse;
    try {
        conversationResponse = await reddit.modMail.getConversation({
            conversationId: normaliseConversationId(event.conversationId),
        });
    } catch (error) {
        console.log("Error in modmail event:", JSON.stringify(event, null, 2));
        console.log(error);
        return c.json<TriggerResponse>({ message: "Error fetching conversation" }, 500);
    }

    if (!conversationResponse.conversation) {
        return c.json<TriggerResponse>({ message: "Conversation not found" }, 404);
    }

    const messagesInConversation = getSortedMessages(conversationResponse.conversation);
    const firstMessage = messagesInConversation[0];
    if (!firstMessage) {
        return c.json<TriggerResponse>({ message: "First message not found" }, 404);
    }

    const isFirstMessage = firstMessage.id !== undefined && normaliseMessageId(event.messageId) === normaliseMessageId(firstMessage.id);

    const currentMessage = messagesInConversation.find(message => message.id && normaliseMessageId(event.messageId) === normaliseMessageId(message.id));

    if (!currentMessage?.author?.name || !conversationResponse.conversation.subject || !currentMessage.bodyMarkdown) {
        return c.json<TriggerResponse>({ message: "Invalid message data" }, 400);
    }

    if (await hasEventBeenHandled(normaliseMessageId(event.messageId))) {
        return c.json<TriggerResponse>({ message: "Trigger already handled" }, 200);
    }

    const modmail: ModmailMessage = {
        conversationId: normaliseConversationId(event.conversationId),
        createdAt: new Date(firstMessage.date ?? Date.now()),
        subject: conversationResponse.conversation.subject,
        participant: conversationResponse.conversation.participant?.name,
        messageAuthor: currentMessage.author.name ?? "",
        messageAuthorIsMod: currentMessage.author.isMod ?? false,
        bodyMarkdown: currentMessage.bodyMarkdown,
        firstMessageBodyMarkdown: firstMessage.bodyMarkdown,
        isFirstMessage,
        isInternal: currentMessage.isInternal ?? false,
        isHighlighted: conversationResponse.conversation.isHighlighted,
    };

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubredditModmail(modmail);
    } else if (modmail.participant) {
        await handleClientSubredditModmail(modmail);
    }

    return c.json<TriggerResponse>({ message: "Modmail handled successfully" }, 200);
};
