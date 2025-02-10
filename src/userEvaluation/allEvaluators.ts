import { EvaluateCopyBot } from "./EvaluateCopyBot.js";
import { EvaluateDomainSharer } from "./EvaluateDomainSharer.js";
import { EvaluateMixedBot } from "./EvaluateMixedBot.js";
import { EvaluateNSFWKarmaFarmer } from "./EvaluateNSFWKarmaFarmer.js";
import { EvaluateShortTlc } from "./EvaluateShortTlc.js";
import { EvaluateZombie } from "./EvaluateZombie.js";
import { EvaluateCQSTester } from "./EvaluateCQSTester.js";
import { EvaluateFirstCommentEmDash } from "./EvaluateFirstCommentEmDash.js";
import { EvaluateResumeSpam } from "./EvaluateResumeSpam.js";
import { EvaluateCommentThenPost } from "./EvaluateCommentThenPost.js";
import { EvaluateCommentBot } from "./EvaluateCommentBot.js";
import { EvaluateCelebBot } from "./EvaluateCelebBot.js";
import { EvaluateAffiliateBot } from "./EvaluateAffiliateBot.js";
import { EvaluateBadUsername } from "./EvaluateBadUsername.js";

export const ALL_EVALUATORS = [
    EvaluateShortTlc,
    EvaluateCopyBot,
    EvaluateMixedBot,
    EvaluateDomainSharer,
    EvaluateZombie,
    EvaluateCQSTester,
    EvaluateNSFWKarmaFarmer,
    EvaluateFirstCommentEmDash,
    EvaluateResumeSpam,
    EvaluateCommentThenPost,
    EvaluateCommentBot,
    EvaluateCelebBot,
    EvaluateAffiliateBot,
    EvaluateBadUsername,
];
