import { Comment, Post, User } from "@devvit/public-api";
import { CommentSubmit } from "@devvit/protos";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { subMonths } from "date-fns";
import { last } from "lodash";
import { domainFromUrl } from "./evaluatorHelpers.js";

export class EvaluateFirstCommentEmDash extends UserEvaluatorBase {
    override name = "First Comment Em Dash";

    override banContentThreshold = 1;

    private eligibleComment (comment: Comment | CommentV2) {
        return isLinkId(comment.parentId);
    }

    override preEvaluateComment (event: CommentSubmit): boolean {
        if (!event.comment) {
            return false;
        }

        return this.eligibleComment(event.comment);
    }

    private eligiblePost (post: Post): boolean {
        return domainFromUrl(post.url) === "i.redd.it";
    }

    override preEvaluatePost (post: Post): boolean {
        return this.eligiblePost(post);
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
        if (comments.length > 10) {
            this.setReason("User has too many comments");
            return false;
        }

        if (comments.length === 0) {
            this.setReason("User has no comments");
            return false;
        }

        if (!comments.every(comment => this.eligibleComment(comment))) {
            this.setReason("User has non-toplevel comments");
            return false;
        }

        const firstComment = last(comments);
        const firstCommentContainsEmDash = firstComment ? firstComment.body.includes("—") : false;
        const atLeastHalfHaveEmDash = comments.filter(comment => comment.body.includes("—")).length / comments.length > 0.5;

        if (!firstCommentContainsEmDash && !atLeastHalfHaveEmDash) {
            this.setReason("User's first comment doesn't contain an em dash, or they have insufficient comments with them");
            return false;
        }

        const posts = history.filter(item => isLinkId(item.id)) as Post[];
        if (posts.length > 0 && posts.some(post => !this.eligiblePost(post))) {
            this.setReason("User has non-matching posts");
            return false;
        }

        return true;
    }
}
