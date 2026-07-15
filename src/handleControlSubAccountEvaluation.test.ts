import { JobContext, RedisClient } from "@devvit/public-api";
import { beforeEach, expect, test, vi } from "vitest";
import { createSubmissionSummaries } from "./handleControlSubAccountEvaluation.js";
import { createUserSummary } from "./UserSummary/userSummary.js";
import { getControlSubSettings } from "./settings.js";

vi.mock("@fsvreddit/bot-bouncer-evaluation", () => ({
    getSocialLinksWithCache: vi.fn(),
    UserEvaluatorBase: class {},
}));
vi.mock("./constants.js", () => ({
    ALL_RELEVANT_EVALUATORS: [],
    CONTROL_SUBREDDIT: "BotBouncer",
    ControlSubredditJob: {
        OpenAISummaryGather: "openAISummary",
    },
    PostFlairTemplate: {
        Banned: "banned",
    },
}));
vi.mock("./dataStore.js", () => ({
    getUserStatus: vi.fn().mockResolvedValue({ userStatus: "pending" }),
    UserStatus: {
        Pending: "pending",
        Banned: "banned",
    },
}));
vi.mock("./userEvaluation/evaluatorVariables.js", () => ({
    getEvaluatorVariables: vi.fn().mockResolvedValue({}),
}));
vi.mock("./UserSummary/userSummary.js", () => ({
    createUserSummary: vi.fn(),
}));
vi.mock("./statistics/submitterStatistics.js", () => ({
    getSubmitterSuccessRate: vi.fn(),
}));
vi.mock("./utility.js", () => ({
    conditionallyCompressString: vi.fn((value: string) => value),
    conditionallyDecompressString: vi.fn((value: string) => value),
}));
vi.mock("./settings.js", () => ({
    getControlSubSettings: vi.fn(),
}));
vi.mock("@fsvreddit/fsv-devvit-helpers", () => ({
    getPostOrCommentById: vi.fn(),
    getUserExtended: vi.fn().mockResolvedValue({ username: "example_user" }),
}));

type InMemoryRedis = RedisClient & {
    values: Map<string, string>;
};

function makeRedis (): InMemoryRedis {
    const values = new Map<string, string>();
    return {
        values,
        exists: vi.fn(async (key: string) => values.has(key)),
        del: vi.fn(async (...keys: string[]) => {
            for (const key of keys) {
                values.delete(key);
            }
        }),
        watch: vi.fn(async (key: string) => {
            let pendingValue: string | undefined;
            return {
                multi: vi.fn(async () => undefined),
                set: vi.fn(async (_key: string, value: string) => {
                    pendingValue = value;
                }),
                exec: vi.fn(async () => {
                    if (values.has(key)) {
                        throw new Error("transaction conflict");
                    }
                    values.set(key, pendingValue ?? "locked");
                }),
                discard: vi.fn(async () => undefined),
            };
        }),
    } as unknown as InMemoryRedis;
}

function makeContext () {
    return {
        subredditName: "BotBouncer",
        appSlug: "bot-bouncer",
        redis: makeRedis(),
        reddit: {
            getPostById: vi.fn().mockResolvedValue({ id: "t3_test" }),
            report: vi.fn().mockResolvedValue(undefined),
            setPostFlair: vi.fn().mockResolvedValue(undefined),
        },
        scheduler: {
            runJob: vi.fn().mockResolvedValue(undefined),
        },
    } as unknown as JobContext;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getControlSubSettings).mockResolvedValue({
        evaluationDisabled: false,
        trustedSubmitters: [],
        reporterBlacklist: [],
        createAISummaryOnNewPosts: true,
    });
});

test("overlapping summary workflows create and schedule summaries only once", async () => {
    const context = makeContext();
    let finishSummary: (() => void) | undefined;
    vi.mocked(createUserSummary).mockImplementation(() => new Promise<boolean>((resolve) => {
        finishSummary = () => resolve(true);
    }));

    const firstRun = createSubmissionSummaries("example_user", "t3_test", context);
    await vi.waitFor(() => expect(createUserSummary).toHaveBeenCalledOnce());

    await createSubmissionSummaries("example_user", "t3_test", context);
    finishSummary?.();
    await firstRun;

    expect(createUserSummary).toHaveBeenCalledOnce();
    expect(context.scheduler.runJob).toHaveBeenCalledOnce();
});
