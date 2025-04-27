import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { UserExtended } from "../extendedDevvit.js";
import markdownEscape from "markdown-escape";

interface BotGroup {
    name: string;
    usernameRegex: RegExp;
    dateFrom: Date;
    dateTo: Date;
    subreddits?: string[];
}

export class EvaluateBotGroup extends UserEvaluatorBase {
    override name = "Bot Group";
    override shortname = "botgroup";
    override banContentThreshold = 1;

    private getBotGroups (): BotGroup[] {
        const keys = this.var
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    private getBioText () {
        const bannableBioText = this.getVariable<string[]>("bantext", []);
        const reportableBioText = this.getVariable<string[]>("reporttext", []);
        return { bannableBioText, reportableBioText };
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (_: Post): boolean {
        const { bannableBioText, reportableBioText } = this.getBioText();

        return bannableBioText.length > 0 || reportableBioText.length > 0;
    }

    override preEvaluateUser (user: UserExtended): boolean {
        const { bannableBioText, reportableBioText } = this.getBioText();

        if (bannableBioText.length === 0 && reportableBioText.length === 0) {
            return false;
        }

        if (user.commentKarma > 2000 || user.linkKarma > 2000) {
            return false;
        }

        const problematicBioText = [...bannableBioText, ...reportableBioText];

        return problematicBioText.some(bioText => user.userDescription && new RegExp(bioText, "u").test(user.userDescription));
    }

    override evaluate (user: UserExtended, history: (Post | Comment)[]): boolean {
        const { bannableBioText, reportableBioText } = this.getBioText();

        if (bannableBioText.length === 0 && reportableBioText.length === 0) {
            return false;
        }

        const bannableBioTextFound = bannableBioText.find(bio => user.userDescription && new RegExp(bio, "u").test(user.userDescription));
        const reportableBioTextFound = reportableBioText.find(bio => user.userDescription && new RegExp(bio, "u").test(user.userDescription));

        if (bannableBioTextFound) {
            this.canAutoBan = true;
            this.hitReason = `Bio text matched regex: ${markdownEscape(bannableBioTextFound)}`;
        } else if (reportableBioTextFound) {
            this.canAutoBan = false;
            this.hitReason = `Bio text matched regex: ${markdownEscape(reportableBioTextFound)}`;
        } else {
            return false;
        }

        return user.nsfw || this.getPosts(history).some(post => post.isNsfw());
    }
}
