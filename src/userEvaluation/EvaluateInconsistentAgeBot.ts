import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post } from "@devvit/public-api";
import { UserExtended } from "../extendedDevvit.js";
import { compact, uniq } from "lodash";

export class EvaluateInconsistentAgeBot extends UserEvaluatorBase {
    override name = "Inconsistent Age Bot";
    override killswitch = "inconsistentage:killswitch";
    override banContentThreshold = 10;
    override canAutoBan = true;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_event: CommentCreate): boolean {
        return false;
    }

    private ageRegex = /^[MFTA]?([12][0-9])/;

    override preEvaluatePost (post: Post): boolean {
        return this.ageRegex.test(post.title) && post.isNsfw();
    }

    override preEvaluateUser (user: UserExtended): boolean {
        return user.commentKarma < 50;
    }

    override evaluate (_user: UserExtended, history: (Post | Comment)[]): boolean {
        const nsfwPosts = this.getPosts(history).filter(post => this.ageRegex.test(post.title) && post.isNsfw());
        if (nsfwPosts.length < 6) {
            console.log("Not enough NSFW posts", nsfwPosts.length);
            return false;
        }

        const agesFound = uniq(compact(nsfwPosts.map((post) => {
            const match = post.title.match(this.ageRegex);
            return match ? parseInt(match[1]) : undefined;
        })));

        console.log("Ages found", agesFound, nsfwPosts.length);

        if (agesFound.length < 3) {
            return false;
        }

        this.hitReason = `Inconsistent Age Bot: Found ${agesFound.length} different ages in ${nsfwPosts.length} posts`;
        return true;
    }
}
