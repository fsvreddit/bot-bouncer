import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId } from "@devvit/shared-types/tid.js";
import { subDays, subYears } from "date-fns";
import { autogenRegex, domainFromUrl } from "./evaluatorHelpers.js";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateZombie extends UserEvaluatorBase {
    override name = "Zombie";
    override shortname = "zombie";

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
        const redditDomains = this.variables["generic:redditdomains"] as string[] | undefined ?? [];
        const domain = domainFromUrl(post.url);
        if (!domain) {
            return false;
        }
        return post.subredditName === "WhatIsMyCQS"
            || redditDomains.includes(domain);
    }

    override preEvaluateUser (user: UserExtended): boolean {
        if (user.createdAt > subYears(new Date(), 7)) {
            this.setReason("Account is too young");
            return false;
        }

        if (user.commentKarma > 1000) {
            this.setReason("User has too much karma");
            return false;
        }

        if (autogenRegex.test(user.username)) {
            this.setReason("Username is autogen");
            return false;
        }

        return true;
    }

    override evaluatorDisabled (): boolean {
        const killswitchSet = this.variables[`${this.shortname}:killswitch`] as boolean | undefined ?? false;
        return killswitchSet && this.context.subredditName !== CONTROL_SUBREDDIT;
    }

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
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
