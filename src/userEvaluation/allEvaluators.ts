import { EvaluateCopyBot } from "./EvaluateCopyBot.js";
import { EvaluateMixedBot } from "./EvaluateMixedBot.js";
import { EvaluateShortTlc } from "./EvaluateShortTlc.js";

export const ALL_EVALUATORS = [
    EvaluateShortTlc,
    EvaluateCopyBot,
    EvaluateMixedBot,
];
