import { EvaluateCopyBot } from "./EvaluateCopyBot.js";
import { EvaluateDomainSharer } from "./EvaluateDomainSharer.js";
import { EvaluateMixedBot } from "./EvaluateMixedBot.js";
import { EvaluateShortTlc } from "./EvaluateShortTlc.js";
import { EvaluateZombie } from "./EvaluateZombie.js";
import { EvaluateCQSTester } from "./EvaluateCQSTester.js";
import { EvaluateFirstCommentEmDash } from "./EvaluateFirstCommentEmDash.js";
import { EvaluateResumeSpam } from "./EvaluateResumeSpam.js";
import { EvaluateCelebBot } from "./EvaluateCelebBot.js";
import { EvaluateAffiliateBot } from "./EvaluateAffiliateBot.js";
import { EvaluateBadUsername } from "./EvaluateBadUsername.js";
import { EvaluateBannedTitles } from "./evaluateStickyPostTitle.js";
import { EvaluateSelfComment } from "./EvaluateSelfComment.js";
import { EvaluateSoccerStreamBot } from "./EvaluateSoccerStreamBot.js";
import { EvaluateRepeatedPhraseBot } from "./EvaluateRepeatedPhraseBot.js";

export const ALL_EVALUATORS = [
    EvaluateShortTlc,
    EvaluateCopyBot,
    EvaluateMixedBot,
    EvaluateDomainSharer,
    EvaluateZombie,
    EvaluateCQSTester,
    EvaluateFirstCommentEmDash,
    EvaluateResumeSpam,
    EvaluateCelebBot,
    EvaluateAffiliateBot,
    EvaluateBadUsername,
    EvaluateBannedTitles,
    EvaluateSelfComment,
    EvaluateSoccerStreamBot,
    EvaluateRepeatedPhraseBot,
];
