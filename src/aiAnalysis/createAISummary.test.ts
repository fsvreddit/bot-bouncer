import { JobContext, RedisClient } from "@devvit/public-api";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { createResponse, openAISummaryLookupAndRespond } from "./createAISummary.js";
import { callOpenAI } from "./openAI.js";

vi.mock("../constants.js", () => ({
    ALL_RELEVANT_EVALUATORS: [],
    CONTROL_SUBREDDIT: "BotBouncer",
    ControlSubredditJob: {
        OpenAISummaryGather: "openAISummary",
        OpenAIUpdateTokenStatsMessage: "openAIUpdateTokenStatsMessage",
    },
    PostFlairTemplate: {
        Banned: "banned",
    },
}));
vi.mock("./openAI.js", () => ({
    callOpenAI: vi.fn(),
}));
vi.mock("./gatherUserDetailsForOpenAI.js", () => ({
    getUserInfoForOpenAI: vi.fn(),
}));
vi.mock("../handleControlSubAccountEvaluation.js", () => ({
    getAccountInitialEvaluationResults: vi.fn(),
}));
vi.mock("../userEvaluation/evaluatorVariables.js", () => ({
    getEvaluatorVariables: vi.fn(),
}));
vi.mock("./common.js", () => ({
    getPromptData: vi.fn(),
}));
vi.mock("../settings.js", () => ({
    getControlSubSettings: vi.fn(),
}));

type InMemoryRedis = RedisClient & {
    values: Map<string, string>;
};

function makeRedis (): InMemoryRedis {
    const values = new Map<string, string>();
    const redis = {
        values,
        exists: vi.fn(async (key: string) => values.has(key)),
        get: vi.fn(async (key: string) => values.get(key)),
        set: vi.fn(async (key: string, value: string) => {
            values.set(key, value);
        }),
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

    return redis;
}

function makeContext () {
    const remove = vi.fn().mockResolvedValue(undefined);
    const submitComment = vi.fn().mockResolvedValue({ remove });
    const context = {
        subredditName: CONTROL_SUBREDDIT,
        reddit: {
            submitComment,
            modMail: {
                reply: vi.fn().mockResolvedValue(undefined),
            },
        },
        redis: makeRedis(),
        scheduler: {
            runJob: vi.fn().mockResolvedValue(undefined),
        },
    } as unknown as JobContext;

    return { context, submitComment, remove };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("createResponse", () => {
    test("creates only one removed post comment for the same idempotency key", async () => {
        const { context, submitComment, remove } = makeContext();
        const options = {
            postId: "t3_test",
            output: "summary",
            idempotencyKey: "openAISummaryResponse:t3_test",
        };

        expect(await createResponse(options, context)).toBe(true);
        expect(await createResponse(options, context)).toBe(false);

        expect(submitComment).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledOnce();
    });

    test("releases the lock when comment creation fails before a response exists", async () => {
        const { context, submitComment } = makeContext();
        submitComment
            .mockRejectedValueOnce(new Error("Reddit unavailable"))
            .mockResolvedValueOnce({ remove: vi.fn().mockResolvedValue(undefined) });
        const options = {
            postId: "t3_test",
            output: "summary",
            idempotencyKey: "openAISummaryResponse:t3_test",
        };

        await expect(createResponse(options, context)).rejects.toThrow("Reddit unavailable");
        await expect(createResponse(options, context)).resolves.toBe(true);

        expect(submitComment).toHaveBeenCalledTimes(2);
    });
});

describe("openAISummaryLookupAndRespond", () => {
    const event = {
        name: "openAISummaryLookup",
        data: {
            username: "example_user",
            postId: "t3_test",
            prompt: "prompt",
            model: "model",
        },
    };

    test("suppresses duplicate model calls and duplicate responses for a post", async () => {
        const { context, submitComment } = makeContext();
        vi.mocked(callOpenAI).mockResolvedValue("result");

        await openAISummaryLookupAndRespond(event, context);
        await openAISummaryLookupAndRespond(event, context);

        expect(callOpenAI).toHaveBeenCalledOnce();
        expect(submitComment).toHaveBeenCalledOnce();
        expect(context.scheduler.runJob).toHaveBeenCalledOnce();
    });

    test("retries response delivery from cache without repeating a completed model call", async () => {
        const { context, submitComment } = makeContext();
        submitComment
            .mockRejectedValueOnce(new Error("Reddit unavailable"))
            .mockResolvedValueOnce({ remove: vi.fn().mockResolvedValue(undefined) });
        vi.mocked(callOpenAI).mockResolvedValue("result");

        await expect(openAISummaryLookupAndRespond(event, context)).rejects.toThrow("Reddit unavailable");
        await expect(openAISummaryLookupAndRespond(event, context)).resolves.toBeUndefined();

        expect(callOpenAI).toHaveBeenCalledOnce();
        expect(submitComment).toHaveBeenCalledTimes(2);
    });

    test("releases the lookup lock when the model call fails so the job can retry", async () => {
        const { context, submitComment } = makeContext();
        vi.mocked(callOpenAI)
            .mockRejectedValueOnce(new Error("OpenAI unavailable"))
            .mockResolvedValueOnce("result");

        await expect(openAISummaryLookupAndRespond(event, context)).rejects.toThrow("OpenAI unavailable");
        await expect(openAISummaryLookupAndRespond(event, context)).resolves.toBeUndefined();

        expect(callOpenAI).toHaveBeenCalledTimes(2);
        expect(submitComment).toHaveBeenCalledOnce();
    });
});
