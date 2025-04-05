import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateObfuscatedBioKeywords extends UserEvaluatorBase {
    override name = "Obfuscated Bio Keywords Bot";
    override killswitch = "obfuscatedbiowords:killswitch";
    override banContentThreshold = 1;

    private getKeywords (): string[] {
        return this.variables["obfuscatedbiowords:keywords"] as string[] | undefined ?? [];
    }

    private bioTextMatches (user: UserExtended): boolean {
        if (!user.userDescription) {
            return false;
        }

        const keywords = this.getKeywords();
        for (const originalKeyword of keywords) {
            // eslint-disable-next-line @typescript-eslint/no-misused-spread
            const keyword = [...originalKeyword.toLowerCase()];
            for (let i = 0; i < keyword.length; i++) {
                keyword[i] = keyword[i].replace("i", "[i1]");
                keyword[i] = keyword[i].replace("o", "[o0]");
                keyword[i] = keyword[i].replace("a", "[a4@]");
                keyword[i] = keyword[i].replace("e", "[e3]");
                keyword[i] = keyword[i].replace("s", "[s5]");
                keyword[i] = keyword[i].replace("t", "[t7]");
                keyword[i] = keyword[i].replace("b", "[b6]");
                keyword[i] = keyword[i].replace("g", "[g9]");
                keyword[i] = keyword[i].replace("l", "[l1]");
                keyword[i] = keyword[i].replace("z", "[z2]");
            }

            const regexText = keyword[0]
                + ".?"
                + keyword.slice(1).join(".{0,2}");

            const regex = new RegExp("\\b" + regexText + "\\b", "i");
            const matches = user.userDescription.match(regex);
            if (!matches || matches.length !== 1) {
                continue;
            }

            if (matches[0].toLowerCase() === originalKeyword.toLowerCase()) {
                continue;
            }

            return true;
        }

        return false;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return this.getKeywords().length > 0;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (_: Post): boolean {
        return this.getKeywords().length > 0;
    }

    override preEvaluateUser (user: UserExtended): boolean {
        if (user.commentKarma > 1000 || user.linkKarma > 5000) {
            return false;
        }

        return this.bioTextMatches(user);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override evaluate (_user: UserExtended, _history: (Post | Comment)[]): boolean {
        return true;
    }
}
