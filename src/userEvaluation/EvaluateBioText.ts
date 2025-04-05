import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateBioText extends UserEvaluatorBase {
    override name = "Bio Text Bot";
    override killswitch = "biotext:killswitch";
    override banContentThreshold = 1;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    private getBioText () {
        const bannableBioText = this.variables["biotext:bantext"] as string[] | undefined ?? [];
        const reportableBioText = this.variables["biotext:reporttext"] as string[] | undefined ?? [];
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

        return problematicBioText.some(title => user.userDescription && new RegExp(title).test(user.userDescription));
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override evaluate (user: UserExtended, _history: (Post | Comment)[]): boolean {
        const { bannableBioText, reportableBioText } = this.getBioText();

        if (bannableBioText.length === 0 && reportableBioText.length === 0) {
            return false;
        }

        if (bannableBioText.some(bio => user.userDescription && new RegExp(bio).test(user.userDescription))) {
            this.canAutoBan = true;
        } else if (reportableBioText.some(bio => user.userDescription && new RegExp(bio).test(user.userDescription))) {
            this.canAutoBan = false;
        } else {
            return false;
        }

        return true;
    }
}
