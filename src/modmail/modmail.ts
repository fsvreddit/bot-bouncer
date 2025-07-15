import { GetConversationResponse, TriggerContext } from "@devvit/public-api";
import { ModMail } from "@devvit/protos";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { handleClientSubredditModmail } from "./clientSubModmail.js";
import { handleControlSubredditModmail } from "./controlSubModmail.js";

export interface ModmailMessage {
    conversationId: string;
    subject: string;
    participant?: string;
    messageAuthor: string;
    messageAuthorIsMod: boolean;
    bodyMarkdown: string;
    isFirstMessage: boolean;
    isInternal: boolean;
}

export async function handleModmail (event: ModMail, context: TriggerContext) {
    if (event.messageAuthor?.name === context.appName) {
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

    const messagesInConversation = Object.values(conversationResponse.conversation.messages);
    const firstMessage = messagesInConversation[0];
    const isFirstMessage = firstMessage.id !== undefined && event.messageId.includes(firstMessage.id);

    const currentMessage = messagesInConversation.find(message => message.id && event.messageId.includes(message.id));

    if (!currentMessage?.author?.name || !conversationResponse.conversation.subject || !currentMessage.bodyMarkdown) {
        return;
    }

    const modmail: ModmailMessage = {
        conversationId: event.conversationId,
        subject: conversationResponse.conversation.subject,
        participant: conversationResponse.conversation.participant?.name,
        messageAuthor: currentMessage.author.name ?? "",
        messageAuthorIsMod: currentMessage.author.isMod ?? false,
        bodyMarkdown: currentMessage.bodyMarkdown,
        isFirstMessage,
        isInternal: currentMessage.isInternal ?? false,
    };

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleControlSubredditModmail(modmail, context);
    } else if (modmail.participant) {
        await handleClientSubredditModmail(modmail, context);
    }
}
