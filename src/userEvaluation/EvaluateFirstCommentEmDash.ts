import { Comment, Post, User } from "@devvit/public-api";
import { CommentSubmit } from "@devvit/protos";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId } from "@devvit/shared-types/tid.js";
import { subMonths } from "date-fns";

export class EvaluateFirstCommentEmDash extends UserEvaluatorBase {
    override name = "First Comment Em Dash";

    override canAutoBan = true;

    private eligibleComment (comment: Comment | CommentV2) {
        if (isCommentId(comment.parentId)) {
            return false;
        }

        return comment.body.includes("—");
    }

    override preEvaluateComment (event: CommentSubmit): boolean {
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
        if (user.createdAt < subMonths(new Date(), 1)) {
            this.setReason("Account is too old");
            return false;
        }

        return true;
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            return false;
        }

        const comments = history.filter(item => isCommentId(item.id)) as Comment[];
        if (comments.length !== 1) {
            this.setReason("User has more than one comment");
            return false;
        }

        if (!this.eligibleComment(comments[0])) {
            this.setReason("User's only comment doesn't contain an em dash");
            return false;
        }

        return true;
    }
}
