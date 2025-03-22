import { Comment, Post, User } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { subWeeks } from "date-fns";

export class EvaluateBadUsername extends UserEvaluatorBase {
    override name = "Bad Username Bot";
    override killswitch = "badusername:killswitch";

    public override banContentThreshold = 1;

    private isBadUsername (username?: string) {
        if (!username) {
            return false;
        }

        const regexes = this.variables["badusername:regexes"] as string[] | undefined ?? [];
        return regexes.some(regex => new RegExp(regex).test(username));
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        return this.isBadUsername(event.author?.name);
    }

    override preEvaluatePost (post: Post): boolean {
        return this.isBadUsername(post.authorName);
    }

    override preEvaluateUser (user: User): boolean {
        if (!this.isBadUsername(user.username)) {
            this.setReason("Username does not match regexes");
            return false;
        }

        const maxAgeWeeks = this.variables["badusername:maxageweeks"] as number | undefined ?? 4;
        if (user.createdAt < subWeeks(new Date(), maxAgeWeeks)) {
            this.setReason("Account is too old");
            return false;
        }

        return true;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            return false;
        }

        return true;
    }
}
