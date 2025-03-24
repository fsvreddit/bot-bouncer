import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post } from "@devvit/public-api";
import { addHours, subDays } from "date-fns";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateShortNonTLC extends UserEvaluatorBase {
    override name = "Short Non-TLC";
    override killswitch = "short-nontlc:killswitch";
    override banContentThreshold = 1;
    override canAutoBan = true;

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

        const regex = this.variables["short-nontlc:regex"] as string | undefined ?? "^.+$";

        return new RegExp(regex).test(event.comment.body) && event.comment.body.length < this.maxCommentLength();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (_: Post): boolean {
        return false;
    }

    override preEvaluateUser (user: UserExtended): boolean {
        const usernameRegexVal = this.variables["short-nontlc:usernameregex"] as string[] | undefined ?? [];
        const regexes = usernameRegexVal.map(val => new RegExp(val));
        if (!regexes.some(regex => regex.test(user.username))) {
            return false;
        }

        return user.createdAt > subDays(new Date(), 7)
            && user.linkKarma < 5
            && user.commentKarma < 20;
    }

    override evaluate (user: UserExtended, history: (Post | Comment)[]): boolean {
        if (history.filter(item => isLinkId(item.id)).length > 0) {
            this.setReason("User has posts");
            return false;
        }

        const comments = history.filter(item => item instanceof Comment) as Comment[];
        if (comments.some(comment => comment.body.length >= this.maxCommentLength())) {
            this.setReason("User has long comments");
            return false;
        }

        if (comments.some(comment => isLinkId(comment.parentId))) {
            this.setReason("User has top-level comments");
            return false;
        }

        const commentProportion = comments.filter(comment => this.getSubreddits().includes(comment.subredditName)).length / comments.length;
        if (commentProportion < 0.6) {
            this.setReason("User has too many comments in wrong subreddits");
            return false;
        }

        const minCommentInterval = this.variables["short-tlc-new:mincommentinterval"] as number | undefined ?? 6;
        if (comments.some(comment => comment.createdAt < addHours(user.createdAt, minCommentInterval))) {
            this.setReason("User has comments too soon after account creation");
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
