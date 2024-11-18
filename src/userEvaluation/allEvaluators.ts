import { EvaluateCopyBot } from "./EvaluateCopyBot.js";
import { EvaluateDomainSharer } from "./EvaluateDomainSharer.js";
import { EvaluateMixedBot } from "./EvaluateMixedBot.js";
import { EvaluateShortTlc } from "./EvaluateShortTlc.js";

export const ALL_EVALUATORS = [
    EvaluateShortTlc,
    EvaluateCopyBot,
    EvaluateMixedBot,
    EvaluateDomainSharer,
];
