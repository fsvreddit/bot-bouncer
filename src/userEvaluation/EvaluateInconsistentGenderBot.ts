import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post } from "@devvit/public-api";
import { UserExtended } from "../extendedDevvit.js";
import { compact, uniq } from "lodash";
import { subWeeks } from "date-fns";

export class EvaluateInconsistentGenderBot extends UserEvaluatorBase {
    override name = "Inconsistent Gender Bot";
    override shortname = "inconsistentgender";
    override banContentThreshold = 6;
    override canAutoBan = true;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_event: CommentCreate): boolean {
        return false;
    }

    public getGenderFromTitle (title: string): string | undefined {
        const genderRegexes = [
            /^(?:18|19|[2-5]\d)(?: ?\[)?([MF])(?:4[FMART])\b/i,
            /^([MF])(?:18|19|[2-5]\d)/i,
            /^(?:18|19|[2-5]\d)([MF])/i,
        ];

        for (const regex of genderRegexes) {
            const match = regex.exec(title);
            if (match?.[1]) {
                return match[1].toUpperCase();
            }
        }

        return;
    }

    override preEvaluatePost (post: Post): boolean {
        return this.getGenderFromTitle(post.title) !== undefined && post.isNsfw();
    }

    override preEvaluateUser (user: UserExtended): boolean {
        return user.commentKarma < 100;
    }

    override evaluate (user: UserExtended, history: (Post | Comment)[]): boolean {
        const nsfwPosts = this.getPosts(history, { since: subWeeks(new Date(), 2) }).filter(post => post.isNsfw());
        if (nsfwPosts.length < 4) {
            return false;
        }

        const gendersFound = uniq(compact(nsfwPosts.map(post => this.getGenderFromTitle(post.title))));

        if (gendersFound.some(gender => gender.length !== 1)) {
            console.log(`Found invalid genders on post title: ${gendersFound.join(", ")}`);
            return false;
        }

        if (gendersFound.length < 2) {
            return false;
        }

        if (nsfwPosts.some(post => post.subredditName === "bodyswap" || post.subredditName.toLowerCase().includes("roleplay") || post.subredditName.toLowerCase().includes("penpals"))) {
            return false;
        }

        if (user.userDescription?.includes("shared") || user.userDescription?.includes("couple") || nsfwPosts.some(post => post.title.toLowerCase().includes("couple"))) {
            this.canAutoBan = false;
        }

        console.log(`Genders found for ${user.username}: ${gendersFound.join(", ")} in ${nsfwPosts.length} posts`);

        this.hitReason = `Inconsistent Gender Bot: Found ${gendersFound.length} different ages in ${nsfwPosts.length} posts`;
        return true;
    }
}
