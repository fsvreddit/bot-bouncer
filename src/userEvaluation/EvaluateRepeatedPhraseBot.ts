import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post } from "@devvit/public-api";
import { subMonths, subYears } from "date-fns";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateRepeatedPhraseBot extends UserEvaluatorBase {
    override name = "Repeated Phrase Bot";
    override shortname = "repeatedphrase";
    override banContentThreshold = 3;
    override canAutoBan = true;

    private eligibleComment (comment: Comment | CommentV2): boolean {
        const phrases = this.variables["repeatedphrase:phrases"] as string[] | undefined ?? [];
        const caseSensitive = this.variables["repeatedphrase:casesensitive"] as boolean | undefined ?? false;

        if (caseSensitive) {
            const matchedPhrases = phrases.filter(phrase => comment.body.includes(phrase));
            this.hitReason = `Matched phrases: ${matchedPhrases.join(", ")}`;
            return matchedPhrases.length > 0;
        } else {
            const matchedPhrases = phrases.filter(phrase => comment.body.toLowerCase().includes(phrase.toLowerCase()));
            this.hitReason = `Matched phrases: ${matchedPhrases.join(", ")}`;
            return matchedPhrases.length > 0;
        }
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
        return user.createdAt > subYears(new Date(), 2)
            && user.linkKarma < 100
            && user.commentKarma < 500;
    }

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
        const posts = this.getPosts(history, { since: subMonths(new Date(), 1) });
        if (posts.length > 0) {
            this.setReason("User has recent posts");
            return false;
        }

        const comments = this.getComments(history);

        if (comments.length < 3) {
            this.setReason("User has insufficient comments to check user");
            return false;
        }

        if (!comments.every(comment => this.eligibleComment(comment))) {
            this.setReason("User has non-eligible comments");
            return false;
        }

        return true;
    }
}
