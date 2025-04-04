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
import { EvaluateShortNonTLC } from "./EvaluateShortNonTLC.js";
import { EvaluateZombieNSFW } from "./EvaluateZombieNSFWPoster.js";
import { EvaluateBioText } from "./EvaluateBioText.js";
import { EvaluateObfuscatedBioKeywords } from "./EvaluateObfuscatedBioKeywords.js";
import { EvaluateSocialLinks } from "./EvaluateSocialLinks.js";
import { EvaluateSuspiciousFirstPost } from "./EvaluateSuspiciousFirstPost.js";

export const ALL_EVALUATORS = [
    EvaluateBadUsername,
    EvaluateBioText,
    EvaluateShortTlc,
    EvaluateMixedBot,
    EvaluateDomainSharer,
    EvaluateZombie,
    EvaluateCQSTester,
    EvaluateFirstCommentEmDash,
    EvaluateResumeSpam,
    EvaluateAffiliateBot,
    EvaluatePinnedPostTitles,
    EvaluateSelfComment,
    EvaluateSoccerStreamBot,
    EvaluateRepeatedPhraseBot,
    EvaluatePostTitle,
    EvaluateShortNonTLC,
    EvaluateZombieNSFW,
    EvaluateObfuscatedBioKeywords,
    EvaluateSocialLinks,
    EvaluateSuspiciousFirstPost,
];
