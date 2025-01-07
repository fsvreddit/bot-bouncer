import { Comment, Post, User } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId } from "@devvit/shared-types/tid.js";
import { subDays, subYears } from "date-fns";
import { autogenRegex, domainFromUrl } from "./evaluatorHelpers.js";

export class EvaluateZombie extends UserEvaluatorBase {
    override name = "Zombie";

    override canAutoBan = false;

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

        if (event.author && autogenRegex.test(event.author.name)) {
            return false;
        }

        return this.eligibleComment(event.comment);
    }

    override preEvaluatePost (post: Post): boolean {
        return post.subredditName === "WhatIsMyCQS"
            || domainFromUrl(post.url) === "reddit.com"
            || domainFromUrl(post.url) === "old.reddit.com"
            || domainFromUrl(post.url) === "i.redd.it";
    }

    override preEvaluateUser (user: User): boolean {
        if (user.createdAt > subYears(new Date(), 7)) {
            this.setReason("Account is too young");
            return false;
        }

        if (autogenRegex.test(user.username)) {
            this.setReason("Username is autogen");
            return false;
        }

        return true;
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            return false;
        }

        const oldContent = history.filter(item => !item.stickied && item.createdAt < subYears(new Date(), 6));
        if (oldContent.length === 0) {
            this.setReason("User doesn't have old content");
            return false;
        }

        if (oldContent.length > 10) {
            this.setReason("User has too much old content");
            return false;
        }

        if (!history.some(item => item.createdAt > subDays(new Date(), 7))) {
            this.setReason("User has no recent content");
            return false;
        }

        if (history.some(item => item.createdAt < subDays(new Date(), 7) && item.createdAt > subYears(new Date(), 6))) {
            this.setReason("User has insufficient gap in history");
            return false;
        }

        return true;
    }
}
