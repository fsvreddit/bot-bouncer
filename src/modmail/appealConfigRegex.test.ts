import {
    type AppealRegexConfig,
    compileAppealConfigRegexes,
    compileAppealConfigs,
    getAppealConfigRegexIssues,
} from "./appealConfigRegex.js";

const supportedRegexProperties = [
    "usernameRegex",
    "~usernameRegex",
    "messageBodyRegex",
    "~messageBodyRegex",
    "evaluatorNameRegex",
    "~evaluatorNameRegex",
    "evaluatorHitReasonRegex",
    "~evaluatorHitReasonRegex",
    "currentEvaluatorNameRegex",
    "~currentEvaluatorNameRegex",
    "currentEvaluatorHitReasonRegex",
    "~currentEvaluatorHitReasonRegex",
    "bioRegex",
    "~bioRegex",
    "originalBioRegex",
    "~originalBioRegex",
    "socialLinkRegex",
    "~socialLinkRegex",
    "originalSocialLinkRegex",
    "~originalSocialLinkRegex",
    "modNoteTextRegex",
    "~modNoteTextRegex",
];

test.each(supportedRegexProperties)("validates %s", (property) => {
    const issues = getAppealConfigRegexIssues([{
        name: "Invalid regex test",
        [property]: ["("],
    }]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(`Invalid regex in ${property}[0] for config Invalid regex test`);
});

test("discovers new regex-shaped properties without a registry update", () => {
    const issues = getAppealConfigRegexIssues([{
        name: "Future regex test",
        futureEvidenceRegex: ["("],
    } as AppealRegexConfig]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("futureEvidenceRegex[0]");
});

test("does not treat the config name as a regular expression", () => {
    const issues = getAppealConfigRegexIssues([{
        name: "(",
        usernameRegex: ["^valid$"],
    }]);

    expect(issues).toEqual([]);
});

test("supports scalar regex values before or after AJV coercion", () => {
    const config = compileAppealConfigRegexes({
        name: "Scalar regex test",
        usernameRegex: "^example$",
    } as unknown as AppealRegexConfig);

    expect(config.compiledRegexes.usernameRegex?.[0].test("EXAMPLE")).toBe(true);
});

test("validates scalar regex values before or after AJV coercion", () => {
    const issues = getAppealConfigRegexIssues([{
        name: "Invalid scalar regex test",
        usernameRegex: "(",
    } as unknown as AppealRegexConfig]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("usernameRegex[0]");
});

test("preserves configured empty regex arrays", () => {
    const config = compileAppealConfigRegexes({
        name: "Empty regex test",
        evaluatorNameRegex: [],
    });

    expect(config.compiledRegexes).toHaveProperty("evaluatorNameRegex");
    expect(config.compiledRegexes.evaluatorNameRegex).toEqual([]);
});

test("reports the invalid array position without including valid expressions", () => {
    const issues = getAppealConfigRegexIssues([{
        name: "Mixed regex test",
        usernameRegex: ["^valid$", "("],
    }]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("usernameRegex[1]");
});

test("uses the same flags during validation and matching", () => {
    const config = compileAppealConfigRegexes({
        "name": "Flags test",
        "usernameRegex": ["^example$"],
        "bioRegex": ["^café$"],
        "~originalBioRegex": ["^café$"],
        "modNoteTextRegex": ["^CaseSensitive$"],
    });

    expect(config.compiledRegexes.usernameRegex?.[0].test("EXAMPLE")).toBe(true);
    expect(config.compiledRegexes.bioRegex?.[0].test("CAFÉ")).toBe(true);
    expect(config.compiledRegexes["~originalBioRegex"]?.[0].test("CAFÉ")).toBe(true);
    expect(config.compiledRegexes.modNoteTextRegex?.[0].test("casesensitive")).toBe(false);
});

test("compiles config batches atomically", () => {
    expect(() => compileAppealConfigs([
        {
            name: "Valid config",
            usernameRegex: ["^valid$"],
        },
        {
            name: "Invalid config",
            usernameRegex: ["("],
        },
    ])).toThrow();
});

test("accepts valid expressions across multiple properties", () => {
    const issues = getAppealConfigRegexIssues([{
        name: "Valid regex test",
        usernameRegex: ["^[A-Za-z0-9_-]+$"],
        bioRegex: ["promotion"],
        socialLinkRegex: ["example\\.com"],
    }]);

    expect(issues).toEqual([]);
});
