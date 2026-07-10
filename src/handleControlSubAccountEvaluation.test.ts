import type { Post, TriggerContext } from "@devvit/public-api";
import { userHasContinuousNSFWHistory } from "./handleControlSubAccountEvaluation.js";

afterEach(() => {
    vi.useRealTimers();
});

interface TestPost {
    createdAt: Date;
    nsfw: boolean;
    subredditName: string;
}

function createContext (posts: TestPost[], nsfwSubreddits: string[] = []): TriggerContext {
    const cache = new Map<string, string>();

    return {
        reddit: {
            getPostsByUser: () => ({
                all: () => Promise.resolve(posts as unknown as Post[]),
            }),
            getSubredditInfoByName: (subredditName: string) => Promise.resolve({
                isNsfw: nsfwSubreddits.includes(subredditName),
            }),
        },
        redis: {
            get: (key: string) => Promise.resolve(cache.get(key)),
            set: (key: string, value: string) => {
                cache.set(key, value);
                return Promise.resolve();
            },
        },
    } as unknown as TriggerContext;
}

function monthlyPosts (dates: string[], nsfw = true, subredditName = "testsub"): TestPost[] {
    return dates.map(date => ({
        createdAt: new Date(date),
        nsfw,
        subredditName,
    }));
}

test("continuous NSFW history handles a six-month window across a year boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));

    const posts = monthlyPosts([
        "2025-08-01T12:00:00Z",
        "2025-09-01T12:00:00Z",
        "2025-10-01T12:00:00Z",
        "2025-11-01T12:00:00Z",
        "2025-12-01T12:00:00Z",
        "2026-01-01T12:00:00Z",
    ]);

    await expect(userHasContinuousNSFWHistory("testuser", createContext(posts))).resolves.toBe(true);
});

test("continuous NSFW history counts posts made in NSFW subreddits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));

    const posts = monthlyPosts([
        "2026-02-01T12:00:00Z",
        "2026-03-01T12:00:00Z",
        "2026-04-01T12:00:00Z",
        "2026-05-01T12:00:00Z",
        "2026-06-01T12:00:00Z",
        "2026-07-01T12:00:00Z",
    ], false, "nsfwcommunity");

    await expect(userHasContinuousNSFWHistory("testuser", createContext(posts, ["nsfwcommunity"]))).resolves.toBe(true);
});

test("continuous NSFW history requires qualifying activity in every month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));

    const posts = monthlyPosts([
        "2026-02-01T12:00:00Z",
        "2026-03-01T12:00:00Z",
        "2026-04-01T12:00:00Z",
        "2026-06-01T12:00:00Z",
        "2026-07-01T12:00:00Z",
    ]);

    await expect(userHasContinuousNSFWHistory("testuser", createContext(posts))).resolves.toBe(false);
});

test("continuous NSFW history rejects a month containing only SFW activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));

    const posts = monthlyPosts([
        "2026-02-01T12:00:00Z",
        "2026-03-01T12:00:00Z",
        "2026-04-01T12:00:00Z",
        "2026-05-01T12:00:00Z",
        "2026-06-01T12:00:00Z",
        "2026-07-01T12:00:00Z",
    ]);
    posts[3].nsfw = false;
    posts[3].subredditName = "sfwcommunity";

    await expect(userHasContinuousNSFWHistory("testuser", createContext(posts))).resolves.toBe(false);
});
