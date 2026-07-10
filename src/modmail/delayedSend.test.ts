import type { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { ControlSubredditJob } from "../constants.js";
import { processDelayedMessages } from "./delayedSend.js";

interface QueueEntry {
    member: string;
    score: number;
}

function createContext (options?: { replyFails?: boolean; archiveFails?: boolean }) {
    const queue: QueueEntry[] = [{
        member: JSON.stringify({
            id: "message-1",
            conversationId: "conversation-1",
            message: "Test reply",
            sendAt: new Date(0),
            archive: true,
        }),
        score: 0,
    }];
    const values = new Map<string, string>();
    let replyCalls = 0;
    let archiveCalls = 0;

    const context = {
        redis: {
            exists: (key: string) => Promise.resolve(values.has(key)),
            set: (key: string, value: string) => {
                values.set(key, value);
                return Promise.resolve();
            },
            del: (key: string) => {
                values.delete(key);
                return Promise.resolve();
            },
            zRange: () => Promise.resolve([...queue]),
            zRem: (_key: string, members: string[]) => {
                for (const member of members) {
                    const index = queue.findIndex(entry => entry.member === member);
                    if (index !== -1) {
                        queue.splice(index, 1);
                    }
                }
                return Promise.resolve();
            },
        },
        reddit: {
            modMail: {
                reply: () => {
                    replyCalls++;
                    return options?.replyFails ? Promise.reject(new Error("reply failed")) : Promise.resolve();
                },
                archiveConversation: () => {
                    archiveCalls++;
                    return options?.archiveFails ? Promise.reject(new Error("archive failed")) : Promise.resolve();
                },
            },
        },
        scheduler: {
            runJob: () => Promise.resolve(),
        },
    } as unknown as JobContext;

    return {
        context,
        queue,
        values,
        getReplyCalls: () => replyCalls,
        getArchiveCalls: () => archiveCalls,
    };
}

const event = {
    name: ControlSubredditJob.ProcessDelayedMessages,
    data: { firstRun: false },
} as ScheduledJobEvent<JSONObject | undefined>;

test("a failed delayed reply remains queued for retry", async () => {
    const state = createContext({ replyFails: true });

    await expect(processDelayedMessages(event, state.context)).rejects.toThrow("reply failed");

    expect(state.queue).toHaveLength(1);
    expect(state.values.has("delayedMessageReplySent~message-1")).toBe(false);
});

test("a delivered delayed reply is removed only after delivery succeeds", async () => {
    const state = createContext();

    await processDelayedMessages(event, state.context);

    expect(state.getReplyCalls()).toBe(1);
    expect(state.getArchiveCalls()).toBe(1);
    expect(state.queue).toHaveLength(0);
    expect(state.values.has("delayedMessageReplySent~message-1")).toBe(true);
});

test("an archive failure retries the archive without sending a duplicate reply", async () => {
    const state = createContext({ archiveFails: true });

    await expect(processDelayedMessages(event, state.context)).rejects.toThrow("archive failed");
    expect(state.queue).toHaveLength(1);
    expect(state.getReplyCalls()).toBe(1);
    expect(state.values.has("delayedMessageReplySent~message-1")).toBe(true);

    const retryState = createContext();
    retryState.values.set("delayedMessageReplySent~message-1", "sent");
    await processDelayedMessages(event, retryState.context);

    expect(retryState.getReplyCalls()).toBe(0);
    expect(retryState.getArchiveCalls()).toBe(1);
    expect(retryState.queue).toHaveLength(0);
});
