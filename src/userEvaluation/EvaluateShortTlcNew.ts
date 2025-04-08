import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId } from "@devvit/shared-types/tid.js";
import { subDays } from "date-fns";
import { autogenRegex } from "./evaluatorHelpers.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateShortTlcNew extends UserEvaluatorBase {
    override name = "Short TLC New Bot";
    override killswitch = "short-tlc-new:killswitch";
    override banContentThreshold = 1;
    override canAutoBan = true;

    private commentRegex = /[A-Z][a-z].+[.?!\p{Emoji}]$/u;

    private eligibleComment (comment: Comment | CommentV2) {
        if (isCommentId(comment.parentId)) {
            return false;
        }

        const commentLengthEligible = comment.body.length < 80
            || (comment.body.length > 160 && comment.body.length < 200);

        return !comment.body.includes("\n")
            && commentLengthEligible
            && this.commentRegex.test(comment.body);
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment || !event.author) {
            return false;
        }

        if (!this.usernameMatchesBotPatterns(event.author.name)) {
            return false;
        }

        return this.eligibleComment(event.comment);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (_: Post): boolean {
        return false;
    }

    override preEvaluateUser (user: UserExtended): boolean {
        if (user.commentKarma > 10) {
            this.setReason("User has too much karma");
            return false;
        }

        const maxAgeInDays = this.variables["short-tlc-new:maxageindays"] as number | undefined ?? 1;
        if (user.createdAt < subDays(new Date(), maxAgeInDays)) {
            this.setReason("Account is too old");
            return false;
        }

        if (!this.usernameMatchesBotPatterns(user.username)) {
            this.setReason("Username does not match regex");
            return false;
        }

        return true;
    }

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
        const userPosts = this.getPosts(history);
        if (userPosts.length > 0) {
            this.setReason("User has posts");
            return false;
        }

        const userComments = this.getComments(history);

        if (!userComments.every(comment => this.eligibleComment(comment))) {
            this.setReason("Mis-matching comment");
            return false;
        }

        const requiredSubs = this.variables["short-tlc-new:requiredsubs"] as string[] | undefined ?? [];
        if (!userComments.some(comment => requiredSubs.includes(comment.subredditName))) {
            this.setReason("User has no comments in required subs");
            return false;
        }

        if (userComments.some(comment => comment.body.length > 80)) {
            this.canAutoBan = false;
        }

        return true;
    }

    private usernameMatchesBotPatterns (username: string): boolean {
        const botUsernameRegexes = this.variables["short-tlc-new:botregexes"] as string[] | undefined ?? [];

        // Check against known bot username patterns.
        if (!botUsernameRegexes.some(regex => new RegExp(regex).test(username))) {
            return false;
        }

        return !autogenRegex.test(username);
    }
}
