import { EvaluateDomainSharer } from "./EvaluateDomainSharer.js";
import { EvaluateMixedBot } from "./EvaluateMixedBot.js";
import { EvaluateFirstCommentEmDash } from "./EvaluateFirstCommentEmDash.js";
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
import { EvaluateEditedComment } from "./EvaluateEditedComment.js";
import { EvaluateInconsistentAgeBot } from "./EvaluateInconsistentAgeBot.js";
import { EvaluateShortTlcNew } from "./EvaluateShortTlcNew.js";
import { EvaluateInconsistentGenderBot } from "./EvaluateInconsistentGenderBot.js";
import { EvaluateOFLinksBot } from "./EvaluateOFLinksBot.js";
import { EvaluateBadDisplayName } from "./EvaluateBadDisplayname.js";
import { EvaluateAdviceBot } from "./EvaluateAdviceBot.js";
import { EvaluateWorldTraveller } from "./EvaluateWorldTraveller.js";
import { EvaluateBotGroup } from "./EvaluateBotGroup.js";
import { EvaluateBadUsernameYoung } from "./EvaluateBadUsernameYoung.js";
import { EvaluateCommentPhrase } from "./EvaluateCommentPhrase.js";
import { EvaluateRapidFireBot } from "./EvaluateRapidFireBot.js";
import { EvaluateAmazonSpam } from "./EvaluateAmazonSpam.js";
import { EvaluateSuspiciousFirstPostPhrase } from "./EvaluateSuspiciousFirstPostPhrase.js";

export const ALL_EVALUATORS = [
    EvaluateBadUsername,
    EvaluateBadUsernameYoung,
    EvaluateBioText,
    EvaluateMixedBot,
    EvaluateDomainSharer,
    EvaluateFirstCommentEmDash,
    EvaluatePinnedPostTitles,
    EvaluateSelfComment,
    EvaluateSoccerStreamBot,
    EvaluateRepeatedPhraseBot,
    EvaluatePostTitle,
    EvaluateZombieNSFW,
    EvaluateObfuscatedBioKeywords,
    EvaluateSocialLinks,
    EvaluateSuspiciousFirstPost,
    EvaluateEditedComment,
    EvaluateInconsistentAgeBot,
    EvaluateInconsistentGenderBot,
    EvaluateShortTlcNew,
    EvaluateOFLinksBot,
    EvaluateBadDisplayName,
    EvaluateAdviceBot,
    EvaluateWorldTraveller,
    EvaluateBotGroup,
    EvaluateCommentPhrase,
    EvaluateRapidFireBot,
    EvaluateAmazonSpam,
    EvaluateSuspiciousFirstPostPhrase,
];
