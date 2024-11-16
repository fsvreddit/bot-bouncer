import { CommentSubmit } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post, User } from "@devvit/public-api";
import { subMonths, subYears } from "date-fns";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";

export class EvaluateMixedBot extends UserEvaluatorBase {
    override getName(): string {
        return "Mixed Bot";
    }

    private readonly emDashRegex = /\w—\w/i;

    private eligibleComment (comment: Comment | CommentV2): boolean {
        return isLinkId(comment.parentId)
            && comment.body.split("\n\n").length <= 3
            && (comment.body.slice(0, 25).includes(",")
                || comment.body.slice(0, 25).includes(".")
                || this.emDashRegex.test(comment.body))
                || comment.body.length < 200
                || comment.body === comment.body.toLowerCase()
    }

    private eligiblePost (post: Post): boolean {
        const domainRegex = /^[iv]\.redd\.it$/;
        return (post.subredditId.toLowerCase().includes("cat") || post.subredditId.toLowerCase().includes("meme"))
            && domainRegex.test(new URL(post.url).hostname);
    }

    override preEvaluateComment(event: CommentSubmit): boolean {
        if (!event.comment) {
            return false;
        }
        return this.eligibleComment(event.comment);
    }

    override preEvaluatePost(post: Post): boolean {
        return this.eligiblePost(post);
    }

    override evaluate(user: User, history: (Post | Comment)[]): boolean {
        if (user.createdAt > subYears(new Date(), 5)) {
            return false;
        }

        if (history.length > 50) {
            return false;
        }

        const posts = history.filter(item => isLinkId(item.id) && item.body !== "[removed]" && item.createdAt > subMonths(new Date(), 1)) as Post[];
        const comments = history.filter(item => isCommentId(item.id) && item.createdAt > subMonths(new Date(), 1)) as Comment[];

        if (posts.length === 0 || comments.length === 0) {
            return false;
        }

        if (!posts.every(post => this.eligiblePost(post))) {
            return false;
        }

        if (!comments.every(comment => this.eligibleComment(comment))) {
            return false;
        }

        if (!posts.some(post => post.title === post.title.toLowerCase())) {
            return false;
        }

        if (!comments.some(comment => this.emDashRegex.test(comment.body))) {
            return false;
        }

        return true;
    }
}
