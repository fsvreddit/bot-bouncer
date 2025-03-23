import { EvaluateCopyBot } from "./EvaluateCopyBot.js";
import { EvaluateDomainSharer } from "./EvaluateDomainSharer.js";
import { EvaluateMixedBot } from "./EvaluateMixedBot.js";
import { EvaluateShortTlc } from "./EvaluateShortTlc.js";
import { EvaluateZombie } from "./EvaluateZombie.js";
import { EvaluateCQSTester } from "./EvaluateCQSTester.js";
import { EvaluateFirstCommentEmDash } from "./EvaluateFirstCommentEmDash.js";
import { EvaluateResumeSpam } from "./EvaluateResumeSpam.js";
import { EvaluateAffiliateBot } from "./EvaluateAffiliateBot.js";
import { EvaluateBadUsername } from "./EvaluateBadUsername.js";
import { EvaluatePinnedPostTitles } from "./EvaluatePinnedPostTitle.js";
import { EvaluateSelfComment } from "./EvaluateSelfComment.js";
import { EvaluateSoccerStreamBot } from "./EvaluateSoccerStreamBot.js";
import { EvaluateRepeatedPhraseBot } from "./EvaluateRepeatedPhraseBot.js";
import { EvaluatePostTitle } from "./EvaluatePostTitle.js";
import { EvaluateShortTlcNew } from "./EvaluateShortTlcNew.js";

export const ALL_EVALUATORS = [
    EvaluateShortTlc,
    EvaluateCopyBot,
    EvaluateMixedBot,
    EvaluateDomainSharer,
    EvaluateZombie,
    EvaluateCQSTester,
    EvaluateFirstCommentEmDash,
    EvaluateResumeSpam,
    EvaluateAffiliateBot,
    EvaluateBadUsername,
    EvaluatePinnedPostTitles,
    EvaluateSelfComment,
    EvaluateSoccerStreamBot,
    EvaluateRepeatedPhraseBot,
    EvaluatePostTitle,
    EvaluateShortTlcNew,
];
