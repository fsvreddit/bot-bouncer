import { Comment, Post, User } from "@devvit/public-api";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { subMonths } from "date-fns";
import { CommentSubmit } from "@devvit/protos";

export class EvaluateCopyBot extends UserEvaluatorBase {
    getName () {
        return "Copy Bot";
    };

    private readonly emDashRegex = /\w—\w/i;

    private eligibleComment (comment: Comment | CommentV2): boolean {
        return (
            isLinkId(comment.parentId)
            && !comment.body.includes("\n")
            && comment.body.length < 1000
        );
    }

    private eligiblePost (post: Post): boolean {
        return (
            post.body !== undefined
            && post.url.includes(post.permalink)
            && post.body.includes("\n\n  \n")
            && post.body.split("\n\n").length <= 3
        );
    }

    private readonly usernameRegex = /^(?:[A-Z][a-z]+[_-]?){2}\d{2,4}$/;

    override preEvaluateComment(event: CommentSubmit): boolean {
        if (!event.comment || !event.author) {
            return false;
        }

        if (!this.usernameRegex.test(event.author.name)) {
            return false;
        }

        return this.eligibleComment(event.comment)
    }

    override preEvaluatePost(post: Post): boolean {
        if (!this.usernameRegex.test(post.authorName)) {
            return false;
        }

        return this.eligiblePost(post);
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.usernameRegex.test(user.username)) {
            return false;
        }

        if (user.createdAt < subMonths(new Date(), 6)) {
            return false;
        }

        if (user.commentKarma > 500 || user.linkKarma > 500) {
            return false;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const userPosts = history.filter(item => item.body !== "[removed]" && item instanceof Post && item.createdAt > subMonths(new Date(), 6)) as Post[];

        if (userPosts.some(post => !this.eligiblePost(post))) {
            return false;
        }

        // At least one post must have an em-dash.
        if (!userPosts.some(post => post.body && this.emDashRegex.test(post.body))) {
            return false;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const userComments = history.filter(item => item instanceof Comment && item.createdAt > subMonths(new Date(), 6)) as Comment[];

        // All comments must be top level
        if (userComments.some(comment => !this.eligibleComment(comment))) {
            return false;
        }

        // At least one comment must include an em-dash
        if (!userComments.some(comment => this.emDashRegex.test(comment.body))) {
            return false;
        }

        return true;
    }
}
