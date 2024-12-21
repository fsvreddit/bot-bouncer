import { EvaluateCopyBot } from "./EvaluateCopyBot.js";
import { EvaluateDomainSharer } from "./EvaluateDomainSharer.js";
import { EvaluateMixedBot } from "./EvaluateMixedBot.js";
import { EvaluateNSFWKarmaFarmer } from "./EvaluateNSFWKarmaFarmer.js";
import { EvaluateShortTlc } from "./EvaluateShortTlc.js";
import { EvaluateVideoFarmer } from "./EvaluateVideoFarmer.js";

export const ALL_EVALUATORS = [
    EvaluateShortTlc,
    EvaluateCopyBot,
    EvaluateMixedBot,
    EvaluateDomainSharer,
    EvaluateVideoFarmer,
    EvaluateNSFWKarmaFarmer,
];
