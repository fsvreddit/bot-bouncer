import { vi, expect, test } from "vitest";

vi.hoisted(() => {
    // @ts-expect-error config stub for tests
    globalThis.devvit = { config: {} };
});

vi.mock("@devvit/web/server", () => ({
    context: {},
    reddit: {},
    redis: {},
    scheduler: {},
}));

vi.mock("@fsvreddit/fsv-devvit-web-helpers", () => ({
    getUserExtended: vi.fn(),
    hasEventBeenHandled: vi.fn(),
    UserExtended: vi.fn(),
}));
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { statusToFlair } from "./postCreation.js";

test("Every user status has a corresponding post flair template", () => {
    const statusNames = Object.values(UserStatus);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const missingStatuses = statusNames.filter(status => statusToFlair[status] === undefined);
    expect(missingStatuses).toEqual([]);
});
