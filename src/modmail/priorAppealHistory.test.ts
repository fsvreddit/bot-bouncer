import type { TriggerContext } from "@devvit/public-api";
import { UserStatus } from "../dataStore.js";
import type { UserDetails } from "../dataStore.js";
import type { ControlSubSettings } from "../settings.js";
import type { ModmailMessage } from "./modmail.js";
import {
    addPriorAppealHistoryNotice,
    getPriorAppealHistoryWarningDays,
    getRecentPriorAppeals,
    parsePriorAppealRecord,
    recordPriorAppealSubmission,
} from "./priorAppealHistory.js";

interface SetOptions {
    nx?: boolean;
}

interface ZMember {
    member: string;
    score: number;
}

function settings (priorAppealHistoryWarningDays?: number): ControlSubSettings {
    return {
        evaluationDisabled: false,
        reporterBlacklist: [],
        trustedSubmitters: [],
        priorAppealHistoryWarningDays,
    };
}

function modmail (conversationId: string, participant = "TestUser"): ModmailMessage {
    return {
        conversationId,
        subject: `Ban dispute for /u/${participant} on /r/TestSub`,
        participant,
        messageAuthor: participant,
        messageAuthorIsMod: false,
        bodyMarkdown: "Please review my appeal.",
        isFirstMessage: true,
        isInternal: false,
    };
}

function userDetails (status: UserStatus.Banned | UserStatus.Purged = UserStatus.Banned): UserDetails {
    return {
        trackingPostId: "t3_test",
        userStatus: status,
        lastUpdate: Date.now(),
        reportedAt: Date.now() - 60_000,
    };
}

function createContext () {
    const strings = new Map<string, string>();
    const sortedSets = new Map<string, Map<string, number>>();
    const replies: { conversationId: string; body: string; isInternal?: boolean }[] = [];
    let replyError: Error | undefined;

    const redis = {
        get: (key: string) => Promise.resolve(strings.get(key)),
        set: (key: string, value: string, options?: SetOptions) => {
            if (!options?.nx || !strings.has(key)) {
                strings.set(key, value);
            }
            return Promise.resolve();
        },
        exists: (key: string) => Promise.resolve(strings.has(key)),
        del: (key: string) => Promise.resolve(strings.delete(key) ? 1 : 0),
        expire: () => Promise.resolve(true),
        zAdd: (key: string, value: ZMember) => {
            const entries = sortedSets.get(key) ?? new Map<string, number>();
            entries.set(value.member, value.score);
            sortedSets.set(key, entries);
            return Promise.resolve(1);
        },
        zRem: (key: string, members: string[]) => {
            const entries = sortedSets.get(key);
            let removed = 0;
            for (const member of members) {
                if (entries?.delete(member)) {
                    removed++;
                }
            }
            return Promise.resolve(removed);
        },
        zRemRangeByScore: (key: string, min: number, max: number) => {
            const entries = sortedSets.get(key);
            let removed = 0;
            for (const [member, score] of entries ?? []) {
                if (score >= min && score <= max) {
                    entries?.delete(member);
                    removed++;
                }
            }
            return Promise.resolve(removed);
        },
        zRange: (key: string, min: number, max: number, options?: { reverse?: boolean }) => {
            const entries = [...(sortedSets.get(key)?.entries() ?? [])]
                .filter(([, score]) => score >= min && score <= max)
                .map(([member, score]) => ({ member, score }))
                .sort((a, b) => options?.reverse ? b.score - a.score : a.score - b.score);
            return Promise.resolve(entries);
        },
    };

    const context = {
        redis,
        reddit: {
            modMail: {
                reply: (reply: { conversationId: string; body: string; isInternal?: boolean }) => {
                    if (replyError) {
                        const error = replyError;
                        replyError = undefined;
                        return Promise.reject(error);
                    }
                    replies.push(reply);
                    return Promise.resolve();
                },
            },
        },
    } as unknown as TriggerContext;

    return {
        context,
        replies,
        redis,
        setReplyError: (error: Error) => {
            replyError = error;
        },
    };
}

afterEach(() => {
    vi.useRealTimers();
});

test("prior appeal history warning days is disabled when no positive setting is configured", () => {
    expect(getPriorAppealHistoryWarningDays(settings())).toBeUndefined();
    expect(getPriorAppealHistoryWarningDays(settings(0))).toBeUndefined();
    expect(getPriorAppealHistoryWarningDays(settings(-1))).toBeUndefined();
});

test("prior appeal history warning days uses configured positive values", () => {
    expect(getPriorAppealHistoryWarningDays(settings(14))).toBe(14);
    expect(getPriorAppealHistoryWarningDays(settings(45))).toBe(45);
});

test("malformed prior appeal records are ignored", () => {
    expect(parsePriorAppealRecord("not json")).toBeUndefined();
    expect(parsePriorAppealRecord(JSON.stringify({ conversationId: "abc" }))).toBeUndefined();
});

test("recording is idempotent and usernames are normalized", async () => {
    const { context } = createContext();
    const appeal = modmail("conversation-1", "MixedCaseUser");

    await recordPriorAppealSubmission(appeal, userDetails(), settings(30), context);
    await recordPriorAppealSubmission(appeal, userDetails(), settings(30), context);

    const records = await getRecentPriorAppeals("mixedcaseuser", 30, "different-conversation", context);
    expect(records).toHaveLength(1);
    expect(records[0].username).toBe("mixedcaseuser");
    expect(records[0].conversationId).toBe("conversation-1");
});

test("concurrent appeal records do not overwrite each other", async () => {
    const { context } = createContext();

    await Promise.all([
        recordPriorAppealSubmission(modmail("conversation-1"), userDetails(), settings(30), context),
        recordPriorAppealSubmission(modmail("conversation-2"), userDetails(), settings(30), context),
    ]);

    const records = await getRecentPriorAppeals("TESTUSER", 30, "conversation-3", context);
    expect(records.map(record => record.conversationId).sort()).toEqual(["conversation-1", "conversation-2"]);
});

test("expired appeal records are omitted from recent history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const { context } = createContext();

    await recordPriorAppealSubmission(modmail("old-conversation"), userDetails(), settings(7), context);
    vi.setSystemTime(new Date("2026-01-09T12:00:00Z"));

    await expect(getRecentPriorAppeals("TestUser", 7, "current-conversation", context)).resolves.toEqual([]);
});

test("notice is neutral, internal, and sent only once", async () => {
    const { context, replies } = createContext();
    await recordPriorAppealSubmission(modmail("previous-conversation"), userDetails(), settings(30), context);

    const currentAppeal = modmail("current-conversation");
    await addPriorAppealHistoryNotice(currentAppeal, settings(30), context);
    await addPriorAppealHistoryNotice(currentAppeal, settings(30), context);

    expect(replies).toHaveLength(1);
    expect(replies[0].isInternal).toBe(true);
    expect(replies[0].body).toContain("previous-conversation");
    expect(replies[0].body).toContain("does not indicate whether any prior appeal was granted, denied, or resolved");
});

test("failed notice delivery releases its lock for retry", async () => {
    const { context, replies, setReplyError } = createContext();
    await recordPriorAppealSubmission(modmail("previous-conversation"), userDetails(), settings(30), context);

    const currentAppeal = modmail("current-conversation");
    setReplyError(new Error("temporary failure"));
    await expect(addPriorAppealHistoryNotice(currentAppeal, settings(30), context)).rejects.toThrow("temporary failure");
    await addPriorAppealHistoryNotice(currentAppeal, settings(30), context);

    expect(replies).toHaveLength(1);
});
