import { expect, test } from "vitest";
import type { ControlSubSettings } from "../settings.js";
import { getSubmitterStatusCells, submitterNeedsGuidance } from "./submitterStatistics.js";

const baseControlSubSettings: ControlSubSettings = {
    evaluationDisabled: false,
    reporterBlacklist: [],
    trustedSubmitters: [],
};

test("existing trusted submitters show bold yes for bulk and trusted", () => {
    const result = getSubmitterStatusCells(
        { submitter: "TrustedUser", count: 500, ratio: 99 },
        { ...baseControlSubSettings, trustedSubmitters: ["TrustedUser"] },
        "bot-bouncer",
    );

    expect(result).toEqual(["**Yes**", "**Yes**", ""]);
});

test("existing bulk submitters show bold yes for bulk but are not recommended for trusted", () => {
    const result = getSubmitterStatusCells(
        { submitter: "BulkUser", count: 500, ratio: 99 },
        { ...baseControlSubSettings, bulkSubmitters: ["BulkUser"] },
        "bot-bouncer",
    );

    expect(result).toEqual(["**Yes**", "", ""]);
});

test("submitter status checks are case-insensitive", () => {
    const result = getSubmitterStatusCells(
        { submitter: "trusteduser", count: 500, ratio: 99 },
        { ...baseControlSubSettings, trustedSubmitters: ["TrustedUser"] },
        "bot-bouncer",
    );

    expect(result).toEqual(["**Yes**", "**Yes**", ""]);
});

test("users meeting recommendation criteria show recommended only when not already bulk or trusted", () => {
    const result = getSubmitterStatusCells(
        { submitter: "CandidateUser", count: 100, ratio: 90 },
        baseControlSubSettings,
        "bot-bouncer",
    );

    expect(result).toEqual(["Recommended", "Recommended", ""]);
});

test("trusted recommendation honors configured threshold and excluded users", () => {
    const settings: ControlSubSettings = {
        ...baseControlSubSettings,
        trustedSubmitterAutoExcludedUsers: ["ExcludedUser"],
        trustedSubmitterAutoThreshold: 95,
    };

    expect(getSubmitterStatusCells({ submitter: "HighButNotEnough", count: 100, ratio: 94 }, settings, "bot-bouncer")).toEqual(["Recommended", "", ""]);
    expect(getSubmitterStatusCells({ submitter: "MeetsThreshold", count: 100, ratio: 95 }, settings, "bot-bouncer")).toEqual(["Recommended", "Recommended", ""]);
    expect(getSubmitterStatusCells({ submitter: "ExcludedUser", count: 100, ratio: 100 }, settings, "bot-bouncer")).toEqual(["Recommended", "", ""]);
});

test("guidance flags require both reversal rate and estimated reversal workload", () => {
    expect(submitterNeedsGuidance({ submitter: "LowVolume", count: 10, ratio: 0 })).toBe(false);
    expect(submitterNeedsGuidance({ submitter: "HighReversalRate", count: 100, ratio: 80 })).toBe(true);
    expect(submitterNeedsGuidance({ submitter: "HighEstimatedReversals", count: 1_000, ratio: 95 })).toBe(true);
});
