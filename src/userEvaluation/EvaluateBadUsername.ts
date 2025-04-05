import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { subWeeks } from "date-fns";
import { UserExtended } from "../extendedDevvit.js";
import markdownEscape from "markdown-escape";

export class EvaluateBadUsername extends UserEvaluatorBase {
    override name = "Bad Username Bot";
    override killswitch = "badusername:killswitch";

    public override banContentThreshold = 1;

    private isBadUsername (username?: string) {
        if (!username) {
            return false;
        }

        const regexes = this.variables["badusername:regexes"] as string[] | undefined ?? [];
        const matchedRegex = regexes.find(regex => new RegExp(regex).test(username));
        if (matchedRegex) {
            this.hitReason = `Username matches regex: ${markdownEscape(matchedRegex)}`;
        }
        return matchedRegex !== undefined;
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        return this.isBadUsername(event.author?.name);
    }

    override preEvaluatePost (post: Post): boolean {
        return this.isBadUsername(post.authorName);
    }

    override preEvaluateUser (user: UserExtended): boolean {
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
    override evaluate (_user: UserExtended, _history: (Post | Comment)[]): boolean {
        return true;
    }
}
