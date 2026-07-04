import { buildEvaluatorConfigEditSummaryWikiPage, nextTopOfHour, summarizeEvaluatorConfigChanges } from "./configEditSummaries.js";

test("summarizeEvaluatorConfigChanges counts array additions and removals by evaluator module", () => {
    const previousVariables = {
        "biotext:bantext": JSON.stringify(["old", "removed", "kept"]),
        "definedhandles:regexes": JSON.stringify(["kept"]),
        "sociallinks:badlinks": JSON.stringify(["removed-link"]),
    };

    const newVariables = {
        "biotext:bantext": JSON.stringify(["old", "kept", "new-1", "new-2", "new-3"]),
        "definedhandles:regexes": JSON.stringify(["kept", "new-handle"]),
        "sociallinks:badlinks": JSON.stringify([]),
    };

    const actual = summarizeEvaluatorConfigChanges(previousVariables, newVariables);

    expect(actual).toEqual({
        biotext: { added: 3, removed: 1 },
        definedhandles: { added: 1, removed: 0 },
        sociallinks: { added: 0, removed: 1 },
    });
});

test("buildEvaluatorConfigEditSummaryWikiPage groups revisions after twenty minutes of inactivity", () => {
    const actual = buildEvaluatorConfigEditSummaryWikiPage([
        {
            timestamp: Date.UTC(2026, 5, 20, 14, 7),
            updatedBy: "CR29-22-2805",
            changes: {
                biotext: { added: 3, removed: 10 },
                definedhandles: { added: 8, removed: 0 },
                sociallinks: { added: 0, removed: 1 },
            },
            revisionReason: "Replace broad social-link rule with narrower bio and handle signals.",
        },
        {
            timestamp: Date.UTC(2026, 5, 20, 14, 22),
            updatedBy: "CR29-22-2805",
            changes: {
                badusername: { added: 2, removed: 0 },
                definedhandles: { added: 1, removed: 0 },
            },
            revisionReason: "Add narrow username pattern from confirmed group.",
        },
        {
            timestamp: Date.UTC(2026, 5, 20, 14, 43),
            updatedBy: "fsv",
            changes: {
                domainsharer: { added: 3, removed: 0 },
            },
            revisionReason: "Add active domains.",
        },
    ], new Date(Date.UTC(2026, 5, 20, 15, 0)));

    expect(actual).toContain("## Revision group: **2026-06-20 14:43 UTC**");
    expect(actual).toContain("## Revision group: **2026-06-20 14:07–14:22 UTC**");
    expect(actual).toContain("* **2026-06-20 14:07 UTC**; applied by **CR29-22-2805**; biotext + 3, - 10; definedhandles + 8; sociallinks - 1. Revision reason: Replace broad social-link rule with narrower bio and handle signals.");
    expect(actual).not.toContain("+ 0");
    expect(actual).not.toContain("- 0");
});

test("buildEvaluatorConfigEditSummaryWikiPage prunes entries older than two weeks", () => {
    const actual = buildEvaluatorConfigEditSummaryWikiPage([
        {
            timestamp: Date.UTC(2026, 5, 1, 12, 0),
            updatedBy: "oldmod",
            changes: { biotext: { added: 1, removed: 0 } },
        },
        {
            timestamp: Date.UTC(2026, 5, 20, 12, 0),
            updatedBy: "newmod",
            changes: { biotext: { added: 1, removed: 0 } },
        },
    ], new Date(Date.UTC(2026, 5, 20, 13, 0)));

    expect(actual).toContain("newmod");
    expect(actual).not.toContain("oldmod");
});

test("nextTopOfHour returns the next exact hour", () => {
    const actual = nextTopOfHour(new Date(Date.UTC(2026, 5, 20, 14, 7, 35)));

    expect(actual.toISOString()).toBe("2026-06-20T15:00:00.000Z");
});
