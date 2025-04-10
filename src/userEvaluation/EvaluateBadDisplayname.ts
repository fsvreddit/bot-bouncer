import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { UserExtended } from "../extendedDevvit.js";
import markdownEscape from "markdown-escape";

export class EvaluateBadDisplayName extends UserEvaluatorBase {
    override name = "Bad Display Name Bot";
    override killswitch = "baddisplayname:killswitch";

    public override banContentThreshold = 1;

    private isBadDisplayName (displayName?: string) {
        if (!displayName) {
            return false;
        }

        const regexes = this.variables["baddisplayname:regexes"] as string[] | undefined ?? [];
        const matchedRegex = regexes.find(regex => new RegExp(regex, "u").test(displayName));
        if (matchedRegex) {
            this.hitReason = `Username matches regex: ${markdownEscape(matchedRegex)}`;
        }
        return matchedRegex !== undefined;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (_: Post): boolean {
        return true;
    }

    override preEvaluateUser (user: UserExtended): boolean {
        if (!this.isBadDisplayName(user.displayName)) {
            this.setReason("Display name does not match regexes");
            return false;
        }

        return user.commentKarma < 100;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override evaluate (_user: UserExtended, _history: (Post | Comment)[]): boolean {
        return true;
    }
}
