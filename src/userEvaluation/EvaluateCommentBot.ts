import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post, User } from "@devvit/public-api";
import { subMonths } from "date-fns";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";

export class EvaluateCommentBot extends UserEvaluatorBase {
    override name = "Comment Bot";
    override banContentThreshold = 20;

    private eligibleComment (comment: Comment | CommentV2): boolean {
        const eligibleComment = comment.body.length < 300
            && (comment.body.split("\n\n").length === 1
                || (comment.body.split("\n\n").length === 2 && comment.body.includes("![gif](giphy")));

        return eligibleComment;
    }

    private eligiblePost (post: Post): boolean {
        const subs = this.variables["comment-then-post:requiredsubs"] as string[] | undefined ?? [];
        return subs.includes(post.subredditName);
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment) {
            return false;
        }
        return this.eligibleComment(event.comment);
    }

    override preEvaluatePost (post: Post): boolean {
        return this.eligiblePost(post);
    }

    override preEvaluateUser (user: User): boolean {
        return user.createdAt > subMonths(new Date(), 1) && user.linkKarma < 10 && user.commentKarma < 500;
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (this.variables["comment-bot:killswitch"]) {
            this.setReason("Killswitch enabled");
            return false;
        }

        if (!this.preEvaluateUser(user)) {
            this.setReason("User is too old or has too much karma");
            return false;
        }

        const posts = history.filter(item => isLinkId(item.id) && item.body !== "[removed]") as Post[];
        if (!posts.every(post => this.eligiblePost(post))) {
            this.setReason("User has non-eligible posts");
            return false;
        }

        const comments = history.filter(item => isCommentId(item.id)) as Comment[];
        if (comments.length < 10) {
            this.setReason("User has insufficient comments to check user");
            return false;
        }

        if (!comments.every(comment => this.eligibleComment(comment))) {
            this.setReason("User has non-eligible comments");
            return false;
        }

        if (!comments.some(comment => comment.body.startsWith("![gif](giphy"))) {
            this.setReason("User does not have a gif comment");
            return false;
        }

        if (comments.some(comment => comment.body.includes("—"))) {
            this.setReason("User has an em dash in a comment");
            return false;
        }

        const replyRatio = comments.filter(comment => isCommentId(comment.parentId)).length / comments.length;
        if (replyRatio > 0.15) {
            this.setReason("User has too high of a reply ratio");
            return false;
        }

        return true;
    }
}
