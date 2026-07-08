import { EvaluationResult } from "../handleControlSubAccountEvaluation.js";
import { evaluationResultMatchesRegexes } from "./autoAppealHandling.js";

function evaluationResult (botName: string, hitReason?: string | { reason: string }): EvaluationResult {
    return {
        botName,
        hitReason: hitReason as EvaluationResult["hitReason"],
        canAutoBan: true,
        metThreshold: true,
    };
}

test("evaluation result regex matching combines evaluator and hit reason", () => {
    const result = evaluationResult("Bot Group Advanced", "Future Laura account");

    expect(evaluationResultMatchesRegexes(result, ["^Bot Group Advanced$"], ["Future Laura"])).toBe(true);
    expect(evaluationResultMatchesRegexes(result, ["^Social Links Bot$"], ["Future Laura"])).toBe(false);
    expect(evaluationResultMatchesRegexes(result, ["^Bot Group Advanced$"], ["Social Links"])).toBe(false);
});

test("evaluation result regex matching supports structured hit reasons", () => {
    const result = evaluationResult("Bot Group Advanced", { reason: "Anime sole post bot" });

    expect(evaluationResultMatchesRegexes(result, ["^Bot Group Advanced$"], ["Anime sole post"])).toBe(true);
});
