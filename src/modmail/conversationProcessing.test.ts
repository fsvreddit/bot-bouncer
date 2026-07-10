import type { TriggerContext } from "@devvit/public-api";
import {
    abandonConversationProcessing,
    beginConversationProcessing,
    completeConversationProcessing,
} from "./conversationProcessing.js";

interface StoredValue {
    value: string;
}

function createContext () {
    const values = new Map<string, StoredValue>();

    const context = {
        redis: {
            exists: (key: string) => Promise.resolve(values.has(key)),
            get: (key: string) => Promise.resolve(values.get(key)?.value),
            set: (key: string, value: string, options?: { nx?: boolean }) => {
                if (!options?.nx || !values.has(key)) {
                    values.set(key, { value });
                }
                return Promise.resolve();
            },
            del: (...keys: string[]) => {
                for (const key of keys) {
                    values.delete(key);
                }
                return Promise.resolve();
            },
        },
    } as unknown as TriggerContext;

    return { context, values };
}

test("conversation processing acquires one lock and rejects a competing worker", async () => {
    const { context } = createContext();

    const firstToken = await beginConversationProcessing("conversation-1", context);
    const secondToken = await beginConversationProcessing("conversation-1", context);

    expect(firstToken).toBeDefined();
    expect(secondToken).toBeUndefined();
});

test("completed conversations are not processed again", async () => {
    const { context, values } = createContext();

    const token = await beginConversationProcessing("conversation-2", context);
    if (!token) {
        throw new Error("Expected the processing lock to be acquired.");
    }

    await completeConversationProcessing("conversation-2", token, context);

    expect(values.has("conversationHandled~conversation-2")).toBe(true);
    expect(values.has("conversationProcessing~conversation-2")).toBe(false);
    await expect(beginConversationProcessing("conversation-2", context)).resolves.toBeUndefined();
});

test("failed processing releases its lock so the conversation can be retried", async () => {
    const { context } = createContext();

    const token = await beginConversationProcessing("conversation-3", context);
    if (!token) {
        throw new Error("Expected the processing lock to be acquired.");
    }

    await abandonConversationProcessing("conversation-3", token, context);

    await expect(beginConversationProcessing("conversation-3", context)).resolves.toBeDefined();
});
