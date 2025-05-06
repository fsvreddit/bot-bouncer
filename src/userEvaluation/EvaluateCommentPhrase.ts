import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { UserExtended } from "../extendedDevvit.js";
import { subDays } from "date-fns";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";

export class EvaluateCommentPhrase extends UserEvaluatorBase {
    override name = "Comment Phrase";
    override shortname = "commentphrase";

    public override banContentThreshold = 1;

    private eligibleComment (comment: Comment | CommentV2): boolean {
        const phrases = this.getVariable<string[]>("phrases", []);
        const maxCommentAgeInDays = this.getVariable<number>("maxcommentageindays", 30);

        if (phrases.length === 0) {
            return false;
        }

        return comment.createdAt > subDays(new Date(), maxCommentAgeInDays)
            && phrases.some(phrase => new RegExp(phrase).test(comment.body));
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment) {
            return false;
        }

        return this.eligibleComment(event.comment);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (_: Post): boolean {
        return false;
    }

    override preEvaluateUser (user: UserExtended): boolean {
        const maxAgeInDays = this.getVariable<number>("maxageindays", 60);
        const maxCommentKarma = this.getVariable<number>("maxcommentkarma", 100);
        return user.commentKarma < maxCommentKarma && user.createdAt > subDays(new Date(), maxAgeInDays);
    }

    override evaluate (_user: UserExtended, history: (Post | Comment)[]): boolean {
        const userComments = this.getComments(history);
        const matchingComments = userComments.filter(comment => this.eligibleComment(comment));
        if (matchingComments.length === 0) {
            this.setReason("No matching comments found.");
            return false;
        }

        const minNumberOfMatchingComments = this.getVariable<number>("minnumberofmatchingcomments", 1);
        if (matchingComments.length < minNumberOfMatchingComments) {
            this.setReason(`Not enough matching comments found. Found ${matchingComments.length}, required ${minNumberOfMatchingComments}.`);
            return false;
        }

        const matchingComment = matchingComments[0];

        const phrases = this.getVariable<string[]>("phrases", []);
        const matchedPhrase = phrases.find(phrase => new RegExp(phrase).test(matchingComment.body));

        if (!matchedPhrase) {
            // Impossible to reach this point.
            this.setReason("No matching phrases found.");
            return false;
        }

        this.hitReason = `Comment found matching regex: "${matchedPhrase}"`;
        return true;
    }
}
