import { Comment, Post, User } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { subWeeks } from "date-fns";
import { last } from "lodash";
import { domainFromUrl } from "./evaluatorHelpers.js";

export class EvaluateFirstCommentEmDash extends UserEvaluatorBase {
    override name = "First Comment Em Dash";

    override banContentThreshold = 1;

    private eligibleComment (comment: Comment | CommentV2) {
        return isLinkId(comment.parentId);
    }

    override preEvaluateComment (event: CommentCreate): boolean {
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
        if (user.createdAt < subWeeks(new Date(), 6)) {
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
        const posts = history.filter(item => isLinkId(item.id)) as Post[];

        if (comments.length > 30) {
            this.setReason("User has too many comments");
            return false;
        }

        if (comments.length === 0) {
            this.setReason("User has no comments");
            return false;
        }

        if (comments.some(comment => !this.eligibleComment(comment))) {
            this.setReason("User has non-toplevel comments");
            return false;
        }

        if (comments.some(comment => posts.some(post => post.id === comment.parentId))) {
            this.setReason("User has comments on their own posts");
            return false;
        }

        const firstComment = last(comments);
        const firstCommentContainsEmDash = firstComment ? firstComment.body.includes("—") : false;

        let emDashThreshold: number;
        if (comments.length > 80) {
            emDashThreshold = 0.2;
        } else if (comments.length > 30) {
            emDashThreshold = 0.25;
        } else {
            emDashThreshold = 0.3;
        }

        const emDashThresholdMet = comments.filter(comment => comment.body.includes("—")).length / comments.length > emDashThreshold;

        if (!firstCommentContainsEmDash && !emDashThresholdMet) {
            this.setReason("User's first comment doesn't contain an em dash, or they have insufficient comments with them");
            return false;
        }

        if (posts.length > 0 && posts.some(post => !this.eligiblePost(post))) {
            this.setReason("User has non-matching posts");
            return false;
        }

        return true;
    }
}
