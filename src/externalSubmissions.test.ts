import { describe, expect, test } from "vitest";
import { resolveExternalSubmissionInitialStatus } from "./externalSubmissions.js";
import { INTERNAL_BOT } from "./constants.js";
import { UserStatus } from "./types.js";

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

    test("treats empty-string submitter values as untrusted external input", () => {
        expect(resolveExternalSubmissionInitialStatus({
            submitter: "",
            initialStatus: UserStatus.Banned,
        }, false)).toBe(UserStatus.Pending);
    });

    test("allows internal submissions to carry any valid evaluator status", () => {
        expect(resolveExternalSubmissionInitialStatus({
            submitter: INTERNAL_BOT,
            initialStatus: UserStatus.Purged,
        }, false)).toBe(UserStatus.Purged);
    });

    test("rejects statuses not supported by external account submission", () => {
        expect(resolveExternalSubmissionInitialStatus({
            submitter: "trusted-user",
            initialStatus: UserStatus.Purged,
        }, true)).toBe(UserStatus.Pending);
    });
