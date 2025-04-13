import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post } from "@devvit/public-api";
import { subMonths, subYears } from "date-fns";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { domainFromUrl } from "./evaluatorHelpers.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateMixedBot extends UserEvaluatorBase {
    override name = "Mixed Bot";
    override shortname = "mixed-bot";

    private readonly emDashRegex = /\w—\w/i;

    private eligibleComment (comment: Comment | CommentV2): boolean {
        const isEligible = isLinkId(comment.parentId)
            && comment.body.split("\n\n").length <= 3
            && (comment.body.slice(0, 25).includes(",")
                || comment.body.slice(0, 25).includes(".")
                || this.emDashRegex.test(comment.body)
                || !comment.body.includes("\n")
                || comment.body === comment.body.toLowerCase()
                || comment.body.length < 50
                || comment.body.includes("\n\n\n\n")
            );

        return isEligible;
    }

    private eligiblePost (post: Post): boolean {
        if (post.subredditName === "WhatIsMyCQS") {
            return true;
        }

        if (!post.url) {
            return false;
        }

        if (post.url.startsWith("/")) {
            return false;
        }

        const redditDomains = this.getGenericVariable<string[]>("redditdomains", []);
        const domain = domainFromUrl(post.url);
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        return (domain && redditDomains.includes(domain)) || post.subredditName === "WhatIsMyCQS";
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

    override preEvaluateUser (user: UserExtended): boolean {
        return (user.createdAt < subYears(new Date(), 5) || user.createdAt > subMonths(new Date(), 6)) && user.commentKarma < 1000;
    }

    override evaluate (user: UserExtended, history: (Post | Comment)[]): boolean {
        if (history.length > 90) {
            this.setReason("User has too many items in history");
            return false;
        }

        const olderContentCount = history.filter(item => item.createdAt < subYears(new Date(), 5)).length;
        if (user.createdAt > subYears(new Date(), 5) && olderContentCount > 5) {
            this.setReason("User has too much old content");
            return false;
        }

        const posts = this.getPosts(history, { since: subMonths(new Date(), 1), omitRemoved: true });
        const comments = this.getComments(history, { since: subMonths(new Date(), 1) });

        if (posts.length === 0 || comments.length === 0) {
            this.setReason("User has missing posts or comments");
            return false;
        }

        if (!posts.every(post => this.eligiblePost(post))) {
            this.setReason("Mismatching post");
            return false;
        }

        if (!comments.every(comment => this.eligibleComment(comment))) {
            this.setReason("Mismatching comment");
            return false;
        }

        if (!posts.some(post => post.title === post.title.toLowerCase() || post.title === post.title.toUpperCase())) {
            this.setReason("No single-case post");
            return false;
        }

        if (!comments.some(comment => this.emDashRegex.test(comment.body))) {
            this.setReason("No comment with an em-dash");
            return false;
        }

        return true;
    }
}
