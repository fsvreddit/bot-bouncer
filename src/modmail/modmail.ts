import { ConversationData, GetConversationResponse, MessageData, TriggerContext } from "@devvit/public-api";
import { ModMail } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { handleClientSubredditModmail } from "./clientSubModmail.js";
import { handleControlSubredditModmail } from "./controlSubModmail.js";
import { hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-helpers";

export interface ModmailMessage {
    conversationId: string;
    createdAt: Date;
    subject: string;
    participant?: string;
    messageAuthor: string;
    messageAuthorIsMod: boolean;
    bodyMarkdown: string;
    isFirstMessage: boolean;
    isInternal: boolean;
    isHighlighted?: boolean;
}

function getSortedMessages (conversation: ConversationData): MessageData[] {
    return Object.values(conversation.messages).sort((a, b) => {
        const dateA = new Date(a.date ?? Date.now());
        const dateB = new Date(b.date ?? Date.now());
        return dateA.getTime() - dateB.getTime();
    });
}

export async function handleModmail (event: ModMail, context: TriggerContext) {
    if (event.messageAuthor?.name === context.appSlug) {
        return;
    }

    let conversationResponse: GetConversationResponse;
    try {
        conversationResponse = await context.reddit.modMail.getConversation({
            conversationId: event.conversationId,
        });
    } catch (error) {
        console.log("Error in modmail event:", JSON.stringify(event, null, 2));
        console.log(error);
        return;
    }

    if (!conversationResponse.conversation) {
        return;
    }

    const messagesInConversation = getSortedMessages(conversationResponse.conversation);
    const firstMessage = messagesInConversation[0];
    const isFirstMessage = firstMessage.id !== undefined && event.messageId === `ModmailMessage_${firstMessage.id}`;

    const currentMessage = messagesInConversation.find(message => message.id && event.messageId === `ModmailMessage_${message.id}`);

    if (!currentMessage?.author?.name || !conversationResponse.conversation.subject || !currentMessage.bodyMarkdown) {
        return;
    }

    if (await hasTriggerBeenHandled(context.redis, event.messageId)) {
        return;
    }

    const modmail: ModmailMessage = {
        conversationId: event.conversationId,
        createdAt: new Date(firstMessage.date ?? Date.now()),
        subject: conversationResponse.conversation.subject,
        participant: conversationResponse.conversation.participant?.name,
        messageAuthor: currentMessage.author.name ?? "",
        messageAuthorIsMod: currentMessage.author.isMod ?? false,
        bodyMarkdown: currentMessage.bodyMarkdown,
        isFirstMessage,
        isInternal: currentMessage.isInternal ?? false,
        isHighlighted: conversationResponse.conversation.isHighlighted,
    };

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubredditModmail(modmail, context);
    } else if (modmail.participant) {
        await handleClientSubredditModmail(modmail, context);
    }
}
