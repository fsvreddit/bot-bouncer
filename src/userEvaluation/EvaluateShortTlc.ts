import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId } from "@devvit/shared-types/tid.js";
import { subMonths } from "date-fns";
import { uniq } from "lodash";
import { autogenRegex } from "./evaluatorHelpers.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateShortTlc extends UserEvaluatorBase {
    override name = "Short TLC Bot";
    override killswitch = "short-tlc:killswitch";

    private eligibleComment (comment: Comment | CommentV2) {
        if (isCommentId(comment.parentId)) {
            return false;
        }

        return !comment.body.includes("\n")
            && comment.body.length < 500;
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
        if (user.commentKarma > 500) {
            this.setReason("User has too much karma");
            return false;
        }

        if (user.createdAt < subMonths(new Date(), 3)) {
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
        const userComments = this.getComments(history);

        if (history.some(item => item instanceof Post && (item.subredditName !== "AskReddit" || item.url.includes("i.redd.it")))) {
            this.setReason("User has posts outside AskReddit/image posts");
            return false;
        }

        if (!userComments.every(comment => this.eligibleComment(comment))) {
            this.setReason("Mis-matching comment");
            return false;
        }

        if (userComments.length > 1 && uniq(userComments.map(comment => comment.subredditName)).length === 1) {
            this.setReason("Single sub user");
            return false;
        }

        if (userComments.some(comment => comment.edited)) {
            this.setReason("User has edited comments");
            return false;
        }

        if (userComments.length < 25) {
            this.setReason("User doesn't have enough comments");
            return false;
        }

        return true;
    }

    private usernameMatchesBotPatterns (username: string): boolean {
        const botUsernameRegexes = this.variables["short-tlc:botregexes"] as string[] | undefined ?? [];

        // Check against known bot username patterns.
        if (!botUsernameRegexes.some(regex => new RegExp(regex).test(username))) {
            return false;
        }

        return !autogenRegex.test(username);
    }
}
