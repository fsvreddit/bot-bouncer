import type { TriggerContext } from "@devvit/public-api";
import { addDays, addMinutes } from "date-fns";

const CONVERSATION_PROCESSING_MINUTES = 10;
const CONVERSATION_HANDLED_DAYS = 28;

function getConversationHandledKey (conversationId: string): string {
    return `conversationHandled~${conversationId}`;
}

function getConversationProcessingKey (conversationId: string): string {
    return `conversationProcessing~${conversationId}`;
}

export async function beginConversationProcessing (conversationId: string, context: TriggerContext): Promise<string | undefined> {
    if (await context.redis.exists(getConversationHandledKey(conversationId))) {
        return;
    }

    const processingKey = getConversationProcessingKey(conversationId);
    const token = `${Date.now()}:${Math.random()}`;
    await context.redis.set(processingKey, token, {
        nx: true,
        expiration: addMinutes(new Date(), CONVERSATION_PROCESSING_MINUTES),
    });

    if (await context.redis.get(processingKey) !== token) {
        return;
    }

    if (await context.redis.exists(getConversationHandledKey(conversationId))) {
        await context.redis.del(processingKey);
        return;
    }

    return token;
}

export async function completeConversationProcessing (conversationId: string, token: string, context: TriggerContext): Promise<void> {
    const processingKey = getConversationProcessingKey(conversationId);
    if (await context.redis.get(processingKey) !== token) {
        return;
    }

    await context.redis.set(getConversationHandledKey(conversationId), "true", {
        expiration: addDays(new Date(), CONVERSATION_HANDLED_DAYS),
    });
    await context.redis.del(processingKey);
}

export async function abandonConversationProcessing (conversationId: string, token: string, context: TriggerContext): Promise<void> {
    const processingKey = getConversationProcessingKey(conversationId);
    if (await context.redis.get(processingKey) === token) {
        await context.redis.del(processingKey);
    }
}
