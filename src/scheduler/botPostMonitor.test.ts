import { BOT_POST_MONITOR_DEFAULT_THRESHOLD_MINUTES, BotPostRecord, getBotPostFreshness, getBotPostMonitorThresholdMinutes } from "./botPostMonitor.js";

function postRecord (createdAt: Date, overrides = {}): BotPostRecord {
    return {
        createdAt,
        id: "t3_test",
        ...overrides,
    };
}

test("bot post freshness is fresh when latest post is newer than default threshold", () => {
    const now = new Date("2026-06-23T15:00:00Z");
    const result = getBotPostFreshness(
        postRecord(new Date("2026-06-23T14:41:00Z")),
        BOT_POST_MONITOR_DEFAULT_THRESHOLD_MINUTES,
        now,
    );

    expect(result.stale).toBe(false);
    expect(result.minutesSinceLatestPost).toBe(BOT_POST_MONITOR_DEFAULT_THRESHOLD_MINUTES - 1);
});

test("bot post freshness is stale when latest post is at default threshold", () => {
    const now = new Date("2026-06-23T15:00:00Z");
    const result = getBotPostFreshness(
        postRecord(new Date("2026-06-23T14:40:00Z")),
        BOT_POST_MONITOR_DEFAULT_THRESHOLD_MINUTES,
        now,
    );

    expect(result.stale).toBe(true);
    expect(result.minutesSinceLatestPost).toBe(BOT_POST_MONITOR_DEFAULT_THRESHOLD_MINUTES);
});

test("bot post freshness uses configured threshold", () => {
    const now = new Date("2026-06-23T15:00:00Z");
    const result = getBotPostFreshness(
        postRecord(new Date("2026-06-23T14:44:00Z")),
        15,
        now,
    );

    expect(result.stale).toBe(true);
    expect(result.minutesSinceLatestPost).toBe(16);
});

test("bot post freshness does not alert before a post creation record exists", () => {
    const result = getBotPostFreshness(undefined, BOT_POST_MONITOR_DEFAULT_THRESHOLD_MINUTES, new Date("2026-06-23T15:00:00Z"));

    expect(result.stale).toBe(false);
    expect(result.latestPost).toBeUndefined();
});

test("bot post monitor threshold defaults to twenty minutes", () => {
    expect(getBotPostMonitorThresholdMinutes({})).toBe(20);
    expect(getBotPostMonitorThresholdMinutes({ botPostMonitorThresholdMinutes: 0 })).toBe(20);
});

test("bot post monitor threshold uses positive configured values", () => {
    expect(getBotPostMonitorThresholdMinutes({ botPostMonitorThresholdMinutes: 15 })).toBe(15);
    expect(getBotPostMonitorThresholdMinutes({ botPostMonitorThresholdMinutes: 20 })).toBe(20);
});
