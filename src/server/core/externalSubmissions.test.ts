import { vi, describe, expect, test } from "vitest";

vi.hoisted(() => {
    globalThis.devvit = { config: {} };
});

vi.mock("@devvit/web/server", () => ({
    context: {},
    reddit: {},
    redis: {},
    scheduler: {},
}));

vi.mock("@fsvreddit/fsv-devvit-web-helpers", () => ({
    getPostOrCommentById: vi.fn(),
    getUserExtended: vi.fn(),
    getUserExtendedFromUser: vi.fn(),
    getUserOrUndefined: vi.fn(),
    hasTriggerBeenHandled: vi.fn(),
}));
import { resolveExternalSubmissionInitialStatus } from "./externalSubmissions.js";
import { INTERNAL_BOT } from "./constants.js";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";

describe("resolveExternalSubmissionInitialStatus", () => {
    test("forces explicit status from an untrusted submitter to pending", () => {
        expect(resolveExternalSubmissionInitialStatus({
            submitter: "ordinary-user",
            initialStatus: UserStatus.Banned,
        }, false)).toBe(UserStatus.Pending);

        expect(resolveExternalSubmissionInitialStatus({
            submitter: "ordinary-user",
            initialStatus: UserStatus.Organic,
        }, false)).toBe(UserStatus.Pending);
    });

    test("preserves supported explicit statuses for trusted submitters", () => {
        expect(resolveExternalSubmissionInitialStatus({
            submitter: "trusted-user",
            initialStatus: UserStatus.Organic,
        }, true)).toBe(UserStatus.Organic);
    });

    test("preserves the existing trusted-submitter banned default", () => {
        expect(resolveExternalSubmissionInitialStatus({
            submitter: "trusted-user",
        }, true)).toBe(UserStatus.Banned);
    });

    test("allows evaluator-driven automatic submissions to start banned", () => {
        expect(resolveExternalSubmissionInitialStatus({
            initialStatus: UserStatus.Banned,
        }, false)).toBe(UserStatus.Banned);
    });

    test("allows internal bot submissions to carry an evaluator status", () => {
        expect(resolveExternalSubmissionInitialStatus({
            submitter: INTERNAL_BOT,
            initialStatus: UserStatus.Banned,
        }, false)).toBe(UserStatus.Banned);
    });

    test("rejects statuses not supported by external account submission", () => {
        expect(resolveExternalSubmissionInitialStatus({
            submitter: "trusted-user",
            initialStatus: UserStatus.Purged,
        }, true)).toBe(UserStatus.Pending);
    });
});
