import { beforeEach, expect, test, vi } from "vitest";

interface SortedSetMember {
    member: string;
    score: number;
}

type ZAdd = (key: string, value: SortedSetMember) => Promise<void>;

vi.hoisted(() => {
    // @ts-expect-error config stub for tests
    globalThis.devvit = { config: {} };
});

const mocks = vi.hoisted(() => ({
    recordBanForSummary: vi.fn(),
    setCleanupForUser: vi.fn(),
}));

vi.mock("@devvit/web/server", () => ({
    context: {},
    reddit: {},
    redis: {},
    scheduler: {},
    settings: {},
}));

vi.mock("@fsvreddit/fsv-devvit-web-helpers", () => ({
    getPostOrCommentById: vi.fn(),
    getUserOrUndefined: vi.fn(),
    hasEventBeenHandled: vi.fn(),
}));

vi.mock("../cleanup.js", () => ({
    setCleanupForUser: mocks.setCleanupForUser,
}));

vi.mock("./modmail/actionSummary.js", () => ({
    recordBanForSummary: mocks.recordBanForSummary,
    recordUnbanForSummary: vi.fn(),
    removeRecordOfBanForSummary: vi.fn(),
}));

import { completeSuccessfulClientSubredditBan } from "./handleClientSubredditClassificationChanges.js";
import { AppSetting } from "../appSettings.js";
import { redis, SettingsValues } from "@devvit/web/server";

function createContext () {
    const zAdd = vi.fn<ZAdd>().mockResolvedValue(undefined);
    (redis as Record<string, unknown>).zAdd = zAdd;
    const addModNote = vi.fn().mockResolvedValue(undefined);

    return { zAdd, addModNote };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordBanForSummary.mockResolvedValue(undefined);
    mocks.setCleanupForUser.mockResolvedValue(undefined);
});

test("does not record successful-ban side effects when the Reddit ban fails", async () => {
    const { zAdd, addModNote } = createContext();
    const settings = {
        [AppSetting.AddModNoteOnClassificationChange]: true,
        [AppSetting.RemoveFromModqueueWhenBanning]: true,
    } as SettingsValues;

    const result = await completeSuccessfulClientSubredditBan(
        { status: "rejected", reason: new Error("Reddit rejected the ban") },
        "TestUser",
        "testsub",
        settings,
    );

    expect(result).toBe(false);
    expect(zAdd).not.toHaveBeenCalled();
    expect(mocks.setCleanupForUser).not.toHaveBeenCalled();
    expect(mocks.recordBanForSummary).not.toHaveBeenCalled();
    expect(addModNote).not.toHaveBeenCalled();
});

test("records the ban and queues modqueue cleanup after a successful Reddit ban", async () => {
    const { zAdd } = createContext();
    const settings = {
        [AppSetting.AddModNoteOnClassificationChange]: false,
        [AppSetting.RemoveFromModqueueWhenBanning]: true,
    } as SettingsValues;

    const result = await completeSuccessfulClientSubredditBan(
        { status: "fulfilled", value: undefined },
        "TestUser",
        "testsub",
        settings,
    );

    expect(result).toBe(true);
    expect(zAdd.mock.calls.map(([key, value]) => ({
        key,
        member: value.member,
        scoreType: typeof value.score,
    }))).toEqual([
        {
            key: "BanStore",
            member: "TestUser",
            scoreType: "number",
        },
        {
            key: "ModqueueRemovalStore",
            member: "TestUser",
            scoreType: "number",
        },
    ]);
    expect(mocks.setCleanupForUser).toHaveBeenCalledWith("TestUser");
    expect(mocks.recordBanForSummary).toHaveBeenCalledWith("TestUser");
});
