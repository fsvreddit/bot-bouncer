import type { SettingsValues, TriggerContext } from "@devvit/public-api";
import { AppSetting } from "./settings.js";

interface SortedSetMember {
    member: string;
    score: number;
}

type ZAdd = (key: string, value: SortedSetMember) => Promise<void>;

const mocks = vi.hoisted(() => ({
    recordBanForSummary: vi.fn(),
    setCleanupForUser: vi.fn(),
}));

vi.mock("./cleanup.js", () => ({
    setCleanupForUser: mocks.setCleanupForUser,
}));

vi.mock("./modmail/actionSummary.js", () => ({
    recordBanForSummary: mocks.recordBanForSummary,
    recordUnbanForSummary: vi.fn(),
    removeRecordOfBanForSummary: vi.fn(),
}));

import { completeSuccessfulClientSubredditBan } from "./handleClientSubredditClassificationChanges.js";

function createContext () {
    const zAdd = vi.fn<ZAdd>().mockResolvedValue(undefined);
    const addModNote = vi.fn().mockResolvedValue(undefined);
    const context = {
        appSlug: "bot-bouncer",
        redis: { zAdd },
        reddit: { addModNote },
    } as unknown as TriggerContext;

    return { context, zAdd, addModNote };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordBanForSummary.mockResolvedValue(undefined);
    mocks.setCleanupForUser.mockResolvedValue(undefined);
});

test("does not record successful-ban side effects when the Reddit ban fails", async () => {
    const { context, zAdd, addModNote } = createContext();
    const settings = {
        [AppSetting.AddModNoteOnClassificationChange]: true,
        [AppSetting.RemoveFromModqueueWhenBanning]: true,
    } as SettingsValues;

    const result = await completeSuccessfulClientSubredditBan(
        { status: "rejected", reason: new Error("Reddit rejected the ban") },
        "TestUser",
        "testsub",
        settings,
        context,
    );

    expect(result).toBe(false);
    expect(zAdd).not.toHaveBeenCalled();
    expect(mocks.setCleanupForUser).not.toHaveBeenCalled();
    expect(mocks.recordBanForSummary).not.toHaveBeenCalled();
    expect(addModNote).not.toHaveBeenCalled();
});

test("records the ban and queues modqueue cleanup after a successful Reddit ban", async () => {
    const { context, zAdd } = createContext();
    const settings = {
        [AppSetting.AddModNoteOnClassificationChange]: false,
        [AppSetting.RemoveFromModqueueWhenBanning]: true,
    } as SettingsValues;

    const result = await completeSuccessfulClientSubredditBan(
        { status: "fulfilled", value: undefined },
        "TestUser",
        "testsub",
        settings,
        context,
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
    expect(mocks.setCleanupForUser).toHaveBeenCalledWith("TestUser", context.redis);
    expect(mocks.recordBanForSummary).toHaveBeenCalledWith("TestUser", context.redis);
});
