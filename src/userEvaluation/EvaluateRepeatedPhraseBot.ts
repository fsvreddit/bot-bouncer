import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post, User } from "@devvit/public-api";
import { subMonths, subYears } from "date-fns";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";

export class EvaluateRepeatedPhraseBot extends UserEvaluatorBase {
    override name = "Repeated Phrase Bot";
    override banContentThreshold = 3;
    override canAutoBan = true;

    private eligibleComment (comment: Comment | CommentV2): boolean {
        const phrases = this.variables["repeatedphrase:phrases"] as string[] | undefined ?? [];
        const caseSensitive = this.variables["repeatedphrase:casesensitive"] as boolean | undefined ?? false;

        if (caseSensitive) {
            return phrases.some(phrase => comment.body.includes(phrase));
        } else {
            return phrases.some(phrase => comment.body.toLowerCase().includes(phrase.toLowerCase()));
        }
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment) {
            return false;
        }

        return this.eligibleComment(event.comment);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (post: Post): boolean {
        return false;
    }

    override preEvaluateUser (user: User): boolean {
        return user.createdAt > subYears(new Date(), 2)
            && user.linkKarma < 100
            && user.commentKarma < 500;
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            this.setReason("User does not pass pre-evaluation checks");
            return false;
        }

        if (this.variables["repeatedphrase:killswitch"]) {
            this.setReason("Evaluator is disabled");
            return false;
        }

        const posts = history.filter(item => isLinkId(item.id) && item.createdAt > subMonths(new Date(), 1)) as Post[];
        if (posts.length > 0) {
            this.setReason("User has recent posts");
            return false;
        }

        const comments = history.filter(item => isCommentId(item.id)) as Comment[];

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
