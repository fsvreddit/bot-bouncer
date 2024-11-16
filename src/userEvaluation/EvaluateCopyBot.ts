import { Comment, Post } from "@devvit/public-api";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId } from "@devvit/shared-types/tid.js";
import { subMonths } from "date-fns";

export class EvaluateCopyBot extends UserEvaluatorBase {
    getName () {
        return "Copy Bot";
    };

    evaluate (): boolean {
        const usernameRegex = /^(?:[A-Z][a-z]+[_-]?){2}\d{2,4}$/;
        if (!usernameRegex.test(this.user.username)) {
            return false;
        }

        if (this.user.createdAt < subMonths(new Date(), 6)) {
            return false;
        }

        if (this.user.commentKarma > 500 || this.user.linkKarma > 500) {
            return false;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const userPosts = this.userHistory.filter(item => item.body !== "[removed]" && item instanceof Post) as Post[];

        const emDashRegex = /\w—\w/i;

        if (userPosts.some(post => !post.body
            // All posts must be self posts.
            || !post.url.includes(post.permalink)
            // All posts must have at least one paragraph.
            || !post.body.includes("\n")
            // Posts must not have more than three paragraphs.
            || post.body.split("\n\n").length > 3)) {
            return false;
        }

        // At least one post must have an em-dash.
        if (!userPosts.some(post => post.body && emDashRegex.test(post.body))) {
            return false;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const userComments = this.userHistory.filter(item => item instanceof Comment) as Comment[];

        // All comments must be top level
        if (userComments.some(comment => isCommentId(comment.parentId)
            // No comment may have a line break
            || comment.body.includes("\n")
            // No comment may be over 1000 characters
            || comment.body.length > 1000)) {
            return false;
        }

        // At least one comment must include an em-dash
        if (!userComments.some(comment => emDashRegex.test(comment.body))) {
            return false;
        }

        return true;
    }
}
