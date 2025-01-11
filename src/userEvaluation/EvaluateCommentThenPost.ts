import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post, User } from "@devvit/public-api";
import { subMonths, subYears } from "date-fns";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { domainFromUrl } from "./evaluatorHelpers.js";
import { uniq } from "lodash";

export class EvaluateCommentThenPost extends UserEvaluatorBase {
    override name = "CommentThenPost";
    override canAutoBan = false;

    private readonly emDashRegex = /\w—\w/i;

    private eligibleComment (comment: Comment | CommentV2): boolean {
        const subs = this.variables["comment-then-post:requiredsubs"] as string[] | undefined ?? [];

        if (comment instanceof Comment) {
            if (!subs.includes(comment.subredditName)) {
                return false;
            }
        } else if (this.context.subredditName) {
            if (!subs.includes(this.context.subredditName)) {
                return false;
            }
        }

        const isEligble = isLinkId(comment.parentId)
            && comment.body.split("\n\n").length <= 3
            && comment.body.length < 300
            && (comment.body.slice(0, 25).includes(",")
                || comment.body.slice(0, 25).includes(".")
                || this.emDashRegex.test(comment.body)
                || !comment.body.includes("\n")
                || comment.body === comment.body.toLowerCase()
                || comment.body.length < 50
            );

        return isEligble;
    }

    private eligiblePost (post: Post): boolean {
        const subs = this.variables["comment-then-post:requiredsubs"] as string[] | undefined ?? [];
        if (!subs.includes(post.subredditName)) {
            return false;
        }

        if (post.subredditName === "WhatIsMyCQS") {
            return true;
        }

        if (!post.url) {
            return false;
        }

        if (post.url.startsWith("/")) {
            return false;
        }

        const redditDomains = this.variables["generic:redditdomains"] as string[] | undefined ?? [];
        const domain = domainFromUrl(post.url);
        return domain !== undefined && redditDomains.includes(domain);
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
        return user.createdAt > subMonths(new Date(), 2);
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            this.setReason("User is too old");
            return false;
        }

        if (history.length > 90) {
            this.setReason("User has too many items in history");
            return false;
        }

        const olderContentCount = history.filter(item => item.createdAt < subYears(new Date(), 5)).length;
        if (user.createdAt > subYears(new Date(), 5) && olderContentCount > 5) {
            this.setReason("User has too much old content");
            return false;
        }

        const posts = history.filter(item => isLinkId(item.id) && item.body !== "[removed]" && item.createdAt > subMonths(new Date(), 1)) as Post[];
        const comments = history.filter(item => isCommentId(item.id) && item.createdAt > subMonths(new Date(), 1)) as Comment[];

        const requiredCommentCount = this.variables["comment-then-post:requiredcomments"] as number | undefined ?? 5;
        if (comments.length < requiredCommentCount) {
            this.setReason("User does not have enough comments");
            return false;
        }

        const requiredPostCount = this.variables["comment-then-post:requiredposts"] as number | undefined ?? 5;
        if (posts.length < requiredPostCount) {
            this.setReason("User does not have enough posts");
            return false;
        }

        const subs = this.variables["comment-then-post:requiredsubs"] as string[] | undefined ?? [];
        if (posts.some(post => !subs.includes(post.subredditName))) {
            this.setReason("User has posts in non-eligible subs");
            return false;
        }

        if (comments.some(comment => !subs.includes(comment.subredditName))) {
            this.setReason("User has comments in non-eligible subs");
            return false;
        }

        if (comments.some(comment => !this.eligibleComment(comment))) {
            this.setReason("User has non-eligible comments");
            return false;
        }

        if (posts.some(post => !this.eligiblePost(post))) {
            this.setReason("User has non-eligible posts");
            return false;
        }

        const distinctPostSubs = uniq(posts.map(post => post.subredditName));
        if (distinctPostSubs.length !== subs.length) {
            this.setReason("User doesn't have posts in all required subs");
        }

        const distinctCommentSubs = uniq(comments.map(comment => comment.subredditName));
        if (distinctCommentSubs.length !== subs.length) {
            this.setReason("User doesn't have comments in all required subs");
        }

        return true;
    }
}
