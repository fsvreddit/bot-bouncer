import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post, User } from "@devvit/public-api";
import { subMonths } from "date-fns";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { domainFromUrl } from "./evaluatorHelpers.js";

export class EvaluateCommentThenPost extends UserEvaluatorBase {
    override name = "CommentThenPost";
    override banContentThreshold = 10;

    private eligibleComment (comment: Comment | CommentV2): boolean {
        const isEligble = isLinkId(comment.parentId)
            && comment.body.length < 150
            && !comment.body.includes("\n");

        return isEligble;
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

        const posts = history.filter(item => isLinkId(item.id) && item.body !== "[removed]") as Post[];
        const comments = history.filter(item => isCommentId(item.id)) as Comment[];

        if (comments.length < 5) {
            this.setReason("User has insufficient initial comment content");
            return false;
        }

        const newestComment = comments[0];
        if (posts.some(post => post.createdAt < newestComment.createdAt)) {
            this.setReason("User has posts older than their oldest comment");
            return false;
        }

        if (posts.length < 5) {
            this.setReason("User does not have enough posts");
            return false;
        }

        const karmaFarmingSubs = this.variables["generic:karmafarminglinksubs"] as string[] | undefined ?? [];
        const postsInKarmaFarmingSubs = posts.filter(post => karmaFarmingSubs.includes(post.subredditName));
        if (postsInKarmaFarmingSubs.length / posts.length < 0.7) {
            this.setReason("User has too few posts in karma farming subs");
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

        return true;
    }
}
