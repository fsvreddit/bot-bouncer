import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId } from "@devvit/shared-types/tid.js";
import { subDays, subMonths } from "date-fns";
import { domainFromUrl } from "./evaluatorHelpers.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateCQSTester extends UserEvaluatorBase {
    override name = "CQS Tester";
    override shortname = "cqstester";

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

        return this.eligibleComment(event.comment);
    }

    override preEvaluatePost (post: Post): boolean {
        const redditDomains = this.getGenericVariable<string[]>("redditdomains", []);
        const domain = domainFromUrl(post.url);
        if (!domain) {
            return false;
        }

        return post.subredditName === "WhatIsMyCQS"
            || redditDomains.includes(domain);
    }

    override preEvaluateUser (user: UserExtended): boolean {
        if (user.createdAt < subDays(new Date(), 7) && user.commentKarma < 50) {
            return true;
        }

        if (user.commentKarma > 500) {
            this.setReason("User has too much comment karma");
            return false;
        }

        if (user.linkKarma > 500) {
            this.setReason("User has too much post karma");
            return false;
        }

        if (user.createdAt < subMonths(new Date(), 6)) {
            this.setReason("Account is too old");
            return false;
        }

        return true;
    }

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
        const userPosts = this.getPosts(history);
        const titlesToCheck = ["Test", "test", "T", "t"];
        if (!userPosts.some(item => item.subredditName === "WhatIsMyCQS" && titlesToCheck.includes(item.title))) {
            this.setReason("User doesn't have a CQS Testing post");
            return false;
        }

        if (history.length > 10) {
            this.setReason("User has too much history");
            return false;
        }

        const userComments = this.getComments(history);
        if (!userComments.every(item => this.eligibleComment(item))) {
            this.setReason("User has non-matching comments");
            return false;
        }

        return true;
    }
}
