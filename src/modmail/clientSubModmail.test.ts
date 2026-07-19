import type { TriggerContext } from "@devvit/public-api";
import type { ModmailMessage } from "./modmail.js";

const mocks = vi.hoisted(() => ({
    getUserStatus: vi.fn(),
    isBanned: vi.fn(),
    wasUserBannedByApp: vi.fn(),
}));

vi.mock("../dataStore.js", () => ({
    getUserStatus: mocks.getUserStatus,
    UserStatus: { Banned: "banned" },
}));

vi.mock("../handleClientSubredditClassificationChanges.js", () => ({
    wasUserBannedByApp: mocks.wasUserBannedByApp,
}));

vi.mock("../settings.js", () => ({
    AppSetting: { AddModmailIfNotBannedYet: "addModmailIfNotBannedYet" },
    CONFIGURATION_DEFAULTS: {
        noteClient: "/u/{account} is listed at {link} for /r/{subreddit}.",
    },
}));

vi.mock("devvit-helpers", () => ({
    isBanned: mocks.isBanned,
}));

import { handleClientSubredditModmail } from "./clientSubModmail.js";

interface TestContext {
    context: TriggerContext;
    getPostById: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    redisValues: Map<string, string>;
}

function createContext (): TestContext {
    const redisValues = new Map<string, string>();
    const reply = vi.fn().mockResolvedValue(undefined);
    const getPostById = vi.fn().mockResolvedValue({ permalink: "https://reddit.com/r/BotBouncer/comments/test" });

    const context = {
        subredditName: "testsub",
        reddit: {
            getCurrentSubredditName: vi.fn().mockResolvedValue("testsub"),
            getPostById,
            modMail: { reply },
        },
        settings: {
            get: vi.fn().mockResolvedValue(false),
        },
        redis: {
            exists: vi.fn((...keys: string[]) => Promise.resolve(keys.filter(key => redisValues.has(key)).length)),
            set: vi.fn((key: string, value: string, options?: { nx?: boolean }) => {
                if (options?.nx && redisValues.has(key)) {
                    return Promise.resolve("");
                }
                redisValues.set(key, value);
                return Promise.resolve("OK");
            }),
            del: vi.fn((...keys: string[]) => {
                for (const key of keys) {
                    redisValues.delete(key);
                }
                return Promise.resolve();
            }),
        },
    } as unknown as TriggerContext;

    return { context, getPostById, reply, redisValues };
}

function createModmail (overrides: Partial<ModmailMessage> = {}): ModmailMessage {
    return {
        conversationId: "conversation-1",
        createdAt: new Date(),
        subject: "Ban dispute",
        participant: "BannedUser",
        messageAuthor: "BannedUser",
        messageAuthorIsMod: false,
        bodyMarkdown: "Please review my ban.",
        isFirstMessage: false,
        isInternal: false,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserStatus.mockResolvedValue({
        trackingPostId: "t3_tracking",
        userStatus: "banned",
    });
    mocks.isBanned.mockResolvedValue(true);
    mocks.wasUserBannedByApp.mockResolvedValue(true);
});

test("adds the note when a banned participant replies to a ban-generated conversation", async () => {
    const { context, reply } = createContext();

    await handleClientSubredditModmail(createModmail({ isFirstMessage: false }), context);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: "conversation-1",
        isInternal: true,
    }));
});

test("adds the note when the participant initiates the conversation", async () => {
    const { context, reply } = createContext();

    await handleClientSubredditModmail(createModmail({ isFirstMessage: true }), context);

    expect(reply).toHaveBeenCalledTimes(1);
});

test("adds no more than one note for multiple participant messages in the same conversation", async () => {
    const { context, reply } = createContext();
    const modmail = createModmail();

    await handleClientSubredditModmail(modmail, context);
    await handleClientSubredditModmail(modmail, context);

    expect(reply).toHaveBeenCalledTimes(1);
});

test("uses the conversation lock to prevent concurrent duplicate notes", async () => {
    const { context, reply } = createContext();
    const modmail = createModmail();

    await Promise.all([
        handleClientSubredditModmail(modmail, context),
        handleClientSubredditModmail(modmail, context),
    ]);

    expect(reply).toHaveBeenCalledTimes(1);
});

test("does not add the participant note for moderator messages", async () => {
    const { context, reply } = createContext();

    await handleClientSubredditModmail(createModmail({
        messageAuthor: "ReviewingMod",
        messageAuthorIsMod: true,
    }), context);

    expect(reply).not.toHaveBeenCalled();
});

test("releases the conversation lock when note delivery fails so a later message can retry", async () => {
    const { context, reply, redisValues } = createContext();
    reply
        .mockRejectedValueOnce(new Error("Reddit API unavailable"))
        .mockResolvedValueOnce(undefined);

    await expect(handleClientSubredditModmail(createModmail(), context)).rejects.toThrow("Reddit API unavailable");
    expect([...redisValues.keys()].some(key => key.startsWith("clientModmailNoteLock:"))).toBe(false);

    await handleClientSubredditModmail(createModmail({ bodyMarkdown: "Following up." }), context);

    expect(reply).toHaveBeenCalledTimes(2);
    expect([...redisValues.keys()].some(key => key.startsWith("clientModmailNoteSent:"))).toBe(true);
});

test("allows one note in each separate conversation", async () => {
    const { context, reply } = createContext();

    await handleClientSubredditModmail(createModmail({ conversationId: "conversation-1" }), context);
    await handleClientSubredditModmail(createModmail({ conversationId: "conversation-2" }), context);

    expect(reply).toHaveBeenCalledTimes(2);
});
