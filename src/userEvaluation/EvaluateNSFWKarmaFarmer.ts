import { Comment, Post, User } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId } from "@devvit/shared-types/tid.js";
import { subDays } from "date-fns";
import { domainFromUrl } from "./evaluatorHelpers.js";

export class EvaluateNSFWKarmaFarmer extends UserEvaluatorBase {
    override name = "NSFW Karma Farmer";

    private eligibleComment (comment: Comment | CommentV2) {
        if (isCommentId(comment.parentId)) {
            return false;
        }

        return !comment.body.includes("\n")
            && comment.body.length < 1000;
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment) {
            return false;
        }

        return this.eligibleComment(event.comment);
    }

    override preEvaluatePost (post: Post): boolean {
        return post.subredditName === "WhatIsMyCQS"
            || domainFromUrl(post.url) === "reddit.com"
            || domainFromUrl(post.url) === "i.redd.it";
    }

    override preEvaluateUser (user: User): boolean {
        if (user.commentKarma > 100) {
            this.setReason("User has too much comment karma");
            return false;
        }

        if (user.linkKarma > 100) {
            this.setReason("User has too much post karma");
            return false;
        }

        if (user.createdAt < subDays(new Date(), 5)) {
            this.setReason("Account is too old");
            return false;
        }

        return true;
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            return false;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- cannot upload without this.
        const userComments = history.filter(item => item instanceof Comment) as Comment[];

        if (!userComments.every(item => this.eligibleComment(item))) {
            this.setReason("User has non-matching comments");
            return false;
        }

        const mandatorySubreddits = ["Free_Nude_Karma", "KarmaNSFW18"];
        if (!mandatorySubreddits.every(subreddit => history.some(item => item.subredditName === subreddit))) {
            this.setReason("User doesn't have posts in all karma farming subreddits");
            return false;
        }

        return true;
    }
}
