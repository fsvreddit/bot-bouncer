import { EvaluateDomainSharer } from "./EvaluateDomainSharer.js";
import { EvaluateMixedBot } from "./EvaluateMixedBot.js";
import { EvaluateZombie } from "./EvaluateZombie.js";
import { EvaluateCQSTester } from "./EvaluateCQSTester.js";
import { EvaluateFirstCommentEmDash } from "./EvaluateFirstCommentEmDash.js";
import { EvaluateResumeSpam } from "./EvaluateResumeSpam.js";
import { EvaluateBadUsername } from "./EvaluateBadUsername.js";
import { EvaluatePinnedPostTitles } from "./EvaluatePinnedPostTitle.js";
import { EvaluateSelfComment } from "./EvaluateSelfComment.js";
import { EvaluateSoccerStreamBot } from "./EvaluateSoccerStreamBot.js";
import { EvaluateRepeatedPhraseBot } from "./EvaluateRepeatedPhraseBot.js";
import { EvaluatePostTitle } from "./EvaluatePostTitle.js";
import { EvaluateZombieNSFW } from "./EvaluateZombieNSFWPoster.js";
import { EvaluateBioText } from "./EvaluateBioText.js";
import { EvaluateObfuscatedBioKeywords } from "./EvaluateObfuscatedBioKeywords.js";
import { EvaluateSocialLinks } from "./EvaluateSocialLinks.js";
import { EvaluateSuspiciousFirstPost } from "./EvaluateSuspiciousFirstPost.js";
import { EvaluateSecretLinksBot } from "./EvaluateSecretLinksBot.js";
import { EvaluateEditedComment } from "./EvaluateEditedComment.js";
import { EvaluateInconsistentAgeBot } from "./EvaluateInconsistentAgeBot.js";
import { EvaluateShortTlcNew } from "./EvaluateShortTlcNew.js";
import { EvaluateInconsistentGenderBot } from "./EvaluateInconsistentGenderBot.js";
import { EvaluateOFLinksBot } from "./EvaluateOFLinksBot.js";
import { EvaluateBadDisplayName } from "./EvaluateBadDisplayname.js";

export const ALL_EVALUATORS = [
    EvaluateBadUsername,
    EvaluateBioText,
    EvaluateMixedBot,
    EvaluateDomainSharer,
    EvaluateZombie,
    EvaluateCQSTester,
    EvaluateFirstCommentEmDash,
    EvaluateResumeSpam,
    EvaluatePinnedPostTitles,
    EvaluateSelfComment,
    EvaluateSoccerStreamBot,
    EvaluateRepeatedPhraseBot,
    EvaluatePostTitle,
    EvaluateZombieNSFW,
    EvaluateObfuscatedBioKeywords,
    EvaluateSocialLinks,
    EvaluateSuspiciousFirstPost,
    EvaluateSecretLinksBot,
    EvaluateEditedComment,
    EvaluateInconsistentAgeBot,
    EvaluateInconsistentGenderBot,
    EvaluateShortTlcNew,
    EvaluateOFLinksBot,
    EvaluateBadDisplayName,
];
