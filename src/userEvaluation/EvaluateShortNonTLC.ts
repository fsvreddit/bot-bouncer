import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post } from "@devvit/public-api";
import { addHours, subDays } from "date-fns";
import { isCommentId } from "@devvit/shared-types/tid.js";
import { UserExtended } from "../extendedDevvit.js";
import { uniq } from "lodash";

export class EvaluateShortNonTLC extends UserEvaluatorBase {
    override name = "Short Non-TLC";
    override killswitch = "short-nontlc:killswitch";
    override banContentThreshold = 1;

    private getSubreddits (): string[] {
        return this.variables["short-nontlc:subreddits"] as string[] | undefined ?? [];
    }

    private maxCommentLength (): number {
        return this.variables["short-nontlc:maxcommentlength"] as number | undefined ?? 50;
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment) {
            return false;
        }

        if (event.comment.body.includes("\n")) {
            return false;
        }

        const regex = this.variables["short-nontlc:regex"] as string | undefined ?? "^.+$";

        return new RegExp(regex).test(event.comment.body) && event.comment.body.length < this.maxCommentLength();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (_: Post): boolean {
        return false;
    }

    override preEvaluateUser (user: UserExtended): boolean {
        if (user.createdAt < subDays(new Date(), 7)
            || user.linkKarma > 5
            || user.commentKarma > 50) {
            return false;
        }

        const usernameRegexVal = this.variables["short-nontlc:usernameregex"] as string[] | undefined ?? [];
        const regexes = usernameRegexVal.map(val => new RegExp(val));
        if (!regexes.some(regex => regex.test(user.username))) {
            return false;
        }

        return true;
    }

    override evaluate (user: UserExtended, history: (Post | Comment)[]): boolean {
        if (this.getPosts(history).length > 0) {
            this.setReason("User has posts");
            return false;
        }

        const comments = this.getComments(history);
        if (comments.some(comment => comment.body.length >= this.maxCommentLength())) {
            this.setReason("User has long comments");
            return false;
        }

        if (comments.some(comment => comment.body.includes("\n"))) {
            this.setReason("User has comments with newlines");
            return false;
        }

        if (comments.length > 10) {
            this.setReason("User has too many comments");
            return false;
        }

        if (!comments.some(comment => isCommentId(comment.parentId))) {
            this.setReason("User has no second-level comments");
            return false;
        }

        if (!comments.some(comment => this.getSubreddits().includes(comment.subredditName))) {
            this.setReason("User has no comments in the specified subreddits");
            return false;
        }

        const commentProportion = comments.filter(comment => this.getSubreddits().includes(comment.subredditName)).length / comments.length;
        if (commentProportion < 0.6) {
            this.canAutoBan = false;
        }

        const minCommentInterval = this.variables["short-tlc-new:mincommentinterval"] as number | undefined ?? 6;
        if (comments.some(comment => comment.createdAt < addHours(user.createdAt, minCommentInterval))) {
            this.setReason("User has comments too soon after account creation");
            return false;
        }

        const distinctSubs = uniq(comments.map(comment => comment.subredditName));
        if (distinctSubs.length !== comments.length) {
            this.setReason("User has more than one comment in the same subreddit");
            return false;
        }

        const regexVal = this.variables["short-nontlc:regex"] as string | undefined ?? "^.+$";
        const regex = new RegExp(regexVal);
        if (comments.some(comment => !regex.test(comment.body))) {
            this.setReason("User has comments that don't match the regular expression");
            return false;
        }

        return true;
    }
}
