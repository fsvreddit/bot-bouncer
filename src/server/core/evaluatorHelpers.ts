import { ALL_EVALUATORS, ALL_INTERNAL_EVALUATORS } from "@fsvreddit/bot-bouncer-evaluation";

/**
 * Evaluator helper consts
 */
export const ALL_RELEVANT_EVALUATORS = [
    ...ALL_EVALUATORS,
    ...ALL_INTERNAL_EVALUATORS,
];
