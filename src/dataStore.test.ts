import { expect, test } from "vitest";
import { shouldStoreClassificationEvent } from "./dataStore.js";
import type { UserDetails } from "./dataStore.js";
import { UserStatus } from "./types.js";

function details (overrides: Partial<UserDetails>): UserDetails {
    return {
        trackingPostId: "t3_test",
        userStatus: UserStatus.Pending,
        lastUpdate: 0,
        ...overrides,
    };
}

test("classification statistics do not count a user classifying their own submission", () => {
    const currentStatus = details({
        userStatus: UserStatus.Pending,
        submitter: "SubmitterUser",
    });
    const updatedStatus = details({
        userStatus: UserStatus.Banned,
        operator: "SubmitterUser",
    });

    expect(shouldStoreClassificationEvent(currentStatus, updatedStatus, "bot-bouncer")).toBe(false);
});

test("classification statistics compare submitter and operator case-insensitively", () => {
    const currentStatus = details({
        userStatus: UserStatus.Pending,
        submitter: "SubmitterUser",
    });
    const updatedStatus = details({
        userStatus: UserStatus.Banned,
        operator: "submitteruser",
    });

    expect(shouldStoreClassificationEvent(currentStatus, updatedStatus, "bot-bouncer")).toBe(false);
});

test("classification statistics count another user classifying a pending submission", () => {
    const currentStatus = details({
        userStatus: UserStatus.Pending,
        submitter: "SubmitterUser",
    });
    const updatedStatus = details({
        userStatus: UserStatus.Banned,
        operator: "ReviewingMod",
    });

    expect(shouldStoreClassificationEvent(currentStatus, updatedStatus, "bot-bouncer")).toBe(true);
});

test("classification statistics do not count app-authored status changes", () => {
    const currentStatus = details({ userStatus: UserStatus.Pending });
    const updatedStatus = details({
        userStatus: UserStatus.Banned,
        operator: "bot-bouncer",
    });

    expect(shouldStoreClassificationEvent(currentStatus, updatedStatus, "bot-bouncer")).toBe(false);
});
