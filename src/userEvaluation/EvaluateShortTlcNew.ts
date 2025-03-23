import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post, User } from "@devvit/public-api";
import { addHours, subDays } from "date-fns";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";

export class EvaluateShortTlcNew extends UserEvaluatorBase {
    override name = "Short TLC New";
    override killswitch = "short-tlc-new:killswitch";
    override banContentThreshold = 1;
    override canAutoBan = true;

    private getSubreddits (): string[] {
        return this.variables["short-tlc-new:subreddits"] as string[] | undefined ?? [];
    }

    private maxCommentLength (): number {
        return this.variables["short-tlc-new:maxcommentlength"] as number | undefined ?? 50;
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment) {
            return false;
        }

        return event.comment.body.length < this.maxCommentLength();
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (_: Post): boolean {
        return false;
    }

    override preEvaluateUser (user: User): boolean {
        return user.createdAt > subDays(new Date(), 2)
            && user.linkKarma < 5
            && user.commentKarma < 20;
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (history.filter(item => isLinkId(item.id)).length > 0) {
            this.setReason("User has posts");
            return false;
        }

        const comments = history.filter(item => item instanceof Comment) as Comment[];
        if (comments.some(comment => comment.body.length >= this.maxCommentLength())) {
            this.setReason("User has long comments");
            return false;
        }

        if (comments.some(comment => isCommentId(comment.parentId))) {
            this.setReason("User has non-top-level comments");
            return false;
        }

        if (comments.some(comment => !this.getSubreddits().includes(comment.subredditName))) {
            this.setReason("User has comments in wrong subreddits");
            return false;
        }

        const minCommentInterval = this.variables["short-tlc-new:mincommentinterval"] as number | undefined ?? 6;
        if (comments.some(comment => comment.createdAt < addHours(user.createdAt, minCommentInterval))) {
            this.setReason("User has comments too soon after account creation");
            return false;
        }

        const regexVal = this.variables["short-tlc-new:regex"] as string | undefined ?? "^.+$";
        const regex = new RegExp(regexVal);
        if (comments.some(comment => !regex.test(comment.body))) {
            this.setReason("User has comments that don't match the regular expression");
            return false;
        }

        return true;
    }
}
