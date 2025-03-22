import { ALL_EVALUATORS } from "./allEvaluators.js";

test("All evaluators have a unique name", () => {
    const evaluatorNames = new Set<string>();
    for (const Evaluator of ALL_EVALUATORS) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
        const evaluator = new Evaluator({} as any, {});
        expect(evaluatorNames.has(evaluator.name)).toBe(false);
        evaluatorNames.add(evaluator.name);
    }
});

test("All evaluators have a unique killswitch name", () => {
    const evaluatorKillswitches = new Set<string>();
    for (const Evaluator of ALL_EVALUATORS) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
        const evaluator = new Evaluator({} as any, {});
        expect(evaluatorKillswitches.has(evaluator.killswitch)).toBe(false);
        evaluatorKillswitches.add(evaluator.name);
    }
});
