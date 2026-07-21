import type { EvaluationResult } from "../handleControlSubAccountEvaluation.js";
import {
    type AppealRegexConfig,
    type AppealRegexProperty,
    type CompiledAppealRegexes,
    compileAppealConfigRegexes,
} from "./appealConfigRegex.js";
import {
    evaluationResultMatchesRegexes,
    negatedAppealRegexesExcludeConfig,
    type NegatedAppealRegexContext,
} from "./autoAppealHandling.js";

function evaluationResult (botName: string, hitReason?: string | { reason: string }): EvaluationResult {
    return {
        botName,
        hitReason: hitReason as EvaluationResult["hitReason"],
        canAutoBan: true,
        metThreshold: true,
    };
}

function compiledRegexesFor (
    property: AppealRegexProperty,
    values: string[],
): CompiledAppealRegexes {
    const config = {
        name: "test",
        [property]: values,
    } as AppealRegexConfig;

    return compileAppealConfigRegexes(config).compiledRegexes;
}

const emptyNegatedContext: NegatedAppealRegexContext = {
    messageBody: "ordinary appeal",
    initialEvaluationResults: [],
    currentEvaluationResults: [],
    originalBio: undefined,
    originalSocialLinks: [],
};

test("evaluation result regex matching combines evaluator and hit reason", () => {
    const result = evaluationResult(
        "Bot Group Advanced",
        "Future Laura account",
    );

    expect(evaluationResultMatchesRegexes(
        result,
        [/^Bot Group Advanced$/i],
        [/Future Laura/i],
    )).toBe(true);

    expect(evaluationResultMatchesRegexes(
        result,
        [/^Social Links Bot$/i],
        [/Future Laura/i],
    )).toBe(false);

    expect(evaluationResultMatchesRegexes(
        result,
        [/^Bot Group Advanced$/i],
        [/Social Links/i],
    )).toBe(false);
});

test("evaluation result regex matching supports structured hit reasons", () => {
    const result = evaluationResult(
        "Bot Group Advanced",
        { reason: "Anime sole post bot" },
    );

    expect(evaluationResultMatchesRegexes(
        result,
        [/^Bot Group Advanced$/i],
        [/Anime sole post/i],
    )).toBe(true);
});

test("configured empty evaluator regex arrays match no evaluation results", () => {
    const result = evaluationResult(
        "Bot Group Advanced",
        "Future Laura account",
    );

    expect(evaluationResultMatchesRegexes(result, [])).toBe(false);
    expect(evaluationResultMatchesRegexes(result, undefined, [])).toBe(false);
});

test("matching negated appeal regexes exclude configs", () => {
    const cases: {
        property: AppealRegexProperty;
        pattern: string;
        context: NegatedAppealRegexContext;
    }[] = [
        {
            property: "~messageBodyRegex",
            pattern: "blocked",
            context: {
                ...emptyNegatedContext,
                messageBody: "This appeal contains a blocked phrase.",
            },
        },
        {
            property: "~evaluatorNameRegex",
            pattern: "blocked evaluator",
            context: {
                ...emptyNegatedContext,
                initialEvaluationResults: [
                    evaluationResult(
                        "Blocked Evaluator",
                        "ordinary reason",
                    ),
                ],
            },
        },
        {
            property: "~evaluatorHitReasonRegex",
            pattern: "blocked reason",
            context: {
                ...emptyNegatedContext,
                initialEvaluationResults: [
                    evaluationResult(
                        "Ordinary Evaluator",
                        "Blocked reason",
                    ),
                ],
            },
        },
        {
            property: "~currentEvaluatorNameRegex",
            pattern: "blocked evaluator",
            context: {
                ...emptyNegatedContext,
                currentEvaluationResults: [
                    evaluationResult(
                        "Blocked Evaluator",
                        "ordinary reason",
                    ),
                ],
            },
        },
        {
            property: "~currentEvaluatorHitReasonRegex",
            pattern: "blocked reason",
            context: {
                ...emptyNegatedContext,
                currentEvaluationResults: [
                    evaluationResult(
                        "Ordinary Evaluator",
                        { reason: "Blocked reason" },
                    ),
                ],
            },
        },
        {
            property: "~originalBioRegex",
            pattern: "blocked bio",
            context: {
                ...emptyNegatedContext,
                originalBio: "This is a blocked bio.",
            },
        },
        {
            property: "~originalSocialLinkRegex",
            pattern: "blocked-site",
            context: {
                ...emptyNegatedContext,
                originalSocialLinks: [{
                    outboundUrl: "https://blocked-site.example/profile",
                }],
            },
        },
    ];

    for (const testCase of cases) {
        const regexes = compiledRegexesFor(
            testCase.property,
            [testCase.pattern],
        );

        expect(negatedAppealRegexesExcludeConfig(
            regexes,
            testCase.context,
        )).toBe(true);
    }

    expect(negatedAppealRegexesExcludeConfig(
        compiledRegexesFor("~messageBodyRegex", ["blocked"]),
        emptyNegatedContext,
    )).toBe(false);
});

test("empty negated evaluator arrays do not exclude configs", () => {
    const context: NegatedAppealRegexContext = {
        ...emptyNegatedContext,
        initialEvaluationResults: [
            evaluationResult(
                "Bot Group Advanced",
                "Future Laura account",
            ),
        ],
        currentEvaluationResults: [
            evaluationResult(
                "Bot Group Advanced",
                "Future Laura account",
            ),
        ],
    };

    expect(negatedAppealRegexesExcludeConfig(
        compiledRegexesFor("~evaluatorNameRegex", []),
        context,
    )).toBe(false);

    expect(negatedAppealRegexesExcludeConfig(
        compiledRegexesFor("~evaluatorHitReasonRegex", []),
        context,
    )).toBe(false);
});
