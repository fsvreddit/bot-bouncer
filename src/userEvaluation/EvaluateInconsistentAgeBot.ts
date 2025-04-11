import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post } from "@devvit/public-api";
import { UserExtended } from "../extendedDevvit.js";
import { compact, uniq } from "lodash";
import { subWeeks } from "date-fns";

export class EvaluateInconsistentAgeBot extends UserEvaluatorBase {
    override name = "Inconsistent Age Bot";
    override killswitch = "inconsistentage:killswitch";
    override banContentThreshold = 6;
    override canAutoBan = true;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_event: CommentCreate): boolean {
        return false;
    }

    private ageRegex = /^[MFTA]?\s?(18|19|2[0-9])(?![$+])/;

    override preEvaluatePost (post: Post): boolean {
        return this.ageRegex.test(post.title) && post.isNsfw();
    }

    override preEvaluateUser (user: UserExtended): boolean {
        return user.commentKarma < 50;
    }

    override evaluate (user: UserExtended, history: (Post | Comment)[]): boolean {
        const nsfwPosts = this.getPosts(history, { since: subWeeks(new Date(), 2) }).filter(post => post.isNsfw());
        if (nsfwPosts.length < 4) {
            this.setReason("User has not posted enough NSFW posts in the last 2 weeks");
            return false;
        }

        const agesFound = uniq(compact(nsfwPosts.map((post) => {
            const match = post.title.match(this.ageRegex);
            return match ? parseInt(match[1]) : undefined;
        })));

        if (agesFound.length < 3) {
            this.setReason(`User has not posted enough different ages in NSFW posts: ${agesFound.join(", ")}`);
            return false;
        }

        if (user.userDescription?.includes("shared") || nsfwPosts.some(post => post.title.toLowerCase().includes("couple"))) {
            this.canAutoBan = false;
        }

        console.log(`Ages found for ${user.username}: ${agesFound.join(", ")} in ${nsfwPosts.length} posts`);

        this.hitReason = `Inconsistent Age Bot: Found ${agesFound.length} different ages in ${nsfwPosts.length} posts`;
        return true;
    }
}
