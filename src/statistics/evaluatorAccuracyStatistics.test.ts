import { compareEvaluatorAccuracyEntries } from "./evaluatorAccuracyStatistics.js";

type AccuracyEntry = Parameters<typeof compareEvaluatorAccuracyEntries>[0];

function makeAccuracyEntry (
    key: string,
    totalCount: number,
    bannedCount: number,
): AccuracyEntry {
    return [
        key,
        {
            totalCount,
            bannedCount,
            bannedAccounts: [],
            unbannedAccounts: [],
        },
    ];
}

test("sorts zero-hit and displayed zero-percent evaluators first, alphabetically within each group", () => {
    const entries: AccuracyEntry[] = [
        makeAccuracyEntry("Bot Group Advanced~Zulu", 10, 5),
        makeAccuracyEntry("Bot Group Advanced~Echo", 10, 1),
        makeAccuracyEntry("Bot Group Advanced~Bravo", 10, 0),
        makeAccuracyEntry("Bot Group Advanced~Alpha", 0, 0),
        makeAccuracyEntry("Bot Group Advanced~Charlie", 200, 1),
        makeAccuracyEntry("Bot Group Advanced~Delta", 10, 2),
    ];

    const sortedKeys = entries
        .sort(compareEvaluatorAccuracyEntries)
        .map(([key]) => key);

    expect(sortedKeys).toEqual([
        "Bot Group Advanced~Alpha",
        "Bot Group Advanced~Bravo",
        "Bot Group Advanced~Charlie",
        "Bot Group Advanced~Delta",
        "Bot Group Advanced~Echo",
        "Bot Group Advanced~Zulu",
    ]);
});
