import { Comment, Post } from "@devvit/public-api";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { subMonths } from "date-fns";
import { CommentCreate } from "@devvit/protos";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateCopyBot extends UserEvaluatorBase {
    override name = "Copy Bot";
    override killswitch = "copy-bot:killswitch";

    private readonly emDashRegex = /\w—\w/i;

    private eligibleComment (comment: Comment | CommentV2): boolean {
        const result = isLinkId(comment.parentId)
            && !comment.body.includes("\n")
            && comment.body.length < 1000;

        return result;
    }

    private eligiblePost (post: Post): boolean {
        const result = post.body !== undefined
            && post.url.includes(post.permalink)
            && post.body.includes("\n\n  \n")
            && post.body.split("\n\n").length <= 3;

        return result;
    }

    private readonly usernameRegex = /^(?:[A-Z][a-z]+[_-]?){2}\d{2,4}$/;

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment || !event.author) {
            return false;
        }

        if (!this.usernameRegex.test(event.author.name)) {
            return false;
        }

        return this.eligibleComment(event.comment);
    }

    override preEvaluatePost (post: Post): boolean {
        if (!this.usernameRegex.test(post.authorName)) {
            return false;
        }

        return this.eligiblePost(post);
    }

    override preEvaluateUser (user: UserExtended): boolean {
        if (!this.usernameRegex.test(user.username)) {
            this.setReason("Username does not match regex");
            return false;
        }

        if (user.createdAt < subMonths(new Date(), 6)) {
            this.setReason("Account is too old");
            return false;
        }

        if (user.commentKarma > 500 || user.linkKarma > 500) {
            this.setReason("Account has too much karma");
            return false;
        }

        return true;
    }

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
        const userPosts = history.filter(item => item.body !== "[removed]" && item instanceof Post && item.createdAt > subMonths(new Date(), 1)) as Post[];

        if (userPosts.length < 2) {
            this.setReason("User does not have enough posts");
            return false;
        }

        if (!userPosts.every(post => this.eligiblePost(post))) {
            this.setReason("Non-matching post");
            return false;
        }

        const userComments = history.filter(item => item instanceof Comment && item.createdAt > subMonths(new Date(), 1)) as Comment[];

        if (!userComments.every(comment => this.eligibleComment(comment))) {
            this.setReason("Non-matching comment");
            return false;
        }

        // At least one post or comment must have an em-dash.
        if (!userPosts.some(post => post.body && this.emDashRegex.test(post.body)) && !userComments.some(comment => this.emDashRegex.test(comment.body))) {
            this.setReason("No post with an em-dash");
            return false;
        }

        return true;
    }
}
