import { vi, expect, test } from "vitest";

vi.hoisted(() => {
    // @ts-expect-error config stub for tests
    globalThis.devvit = { config: {} };
});

vi.mock("@devvit/web/server", () => ({
    context: {},
    reddit: {},
    redis: {},
}));

vi.mock("@fsvreddit/fsv-devvit-web-helpers", () => ({
    getUserExtended: vi.fn(),
    getRedisSubstitionValue: vi.fn(),
    hasEventBeenHandled: vi.fn(),
}));
import { cleanLink } from "./socialLinksStatistics.js";

test("Clean OF link with share code", () => {
    const input = "https://onlyfans.com/angelica06/c72";
    const expected = "https://onlyfans.com/angelica06/";
    const result = cleanLink(input);
    expect(result).toBe(expected);
});

test("Clean OF link with trial invite", () => {
    const input = "https://onlyfans.com/zoeysweets/trial/6ykhbi2mwfelc6sbbbe5ixqjub9yik7h";
    const expected = "https://onlyfans.com/zoeysweets/";
    const result = cleanLink(input);
    expect(result).toBe(expected);
});

test("Clean OF link without share code", () => {
    const input = "https://onlyfans.com/zoememe/";
    const expected = "https://onlyfans.com/zoememe/";
    const result = cleanLink(input);
    expect(result).toBe(expected);
});

test("Clean OF link with www", () => {
    const input = "https://www.onlyfans.com/zoememe/";
    const expected = "https://onlyfans.com/zoememe/";
    const result = cleanLink(input);
    expect(result).toBe(expected);
});
