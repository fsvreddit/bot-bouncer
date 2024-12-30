import { EvaluateCopyBot } from "./EvaluateCopyBot.js";
import { EvaluateDomainSharer } from "./EvaluateDomainSharer.js";
import { EvaluateMixedBot } from "./EvaluateMixedBot.js";
import { EvaluateNSFWKarmaFarmer } from "./EvaluateNSFWKarmaFarmer.js";
import { EvaluateShortTlc } from "./EvaluateShortTlc.js";
import { EvaluateZombie } from "./EvaluateZombie.js";
import { EvaluateCQSTester } from "./EvaluateCQSTester.js";
import { EvaluateVideoFarmer } from "./EvaluateVideoFarmer.js";
import { EvaluateFirstCommentEmDash } from "./EvaluateFirstCommentEmDash.js";

export const ALL_EVALUATORS = [
    EvaluateShortTlc,
    EvaluateCopyBot,
    EvaluateMixedBot,
    EvaluateDomainSharer,
    EvaluateVideoFarmer,
    EvaluateZombie,
    EvaluateCQSTester,
    EvaluateNSFWKarmaFarmer,
    EvaluateFirstCommentEmDash,
];
