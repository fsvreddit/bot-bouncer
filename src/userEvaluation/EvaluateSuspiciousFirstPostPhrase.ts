import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post } from "@devvit/public-api";
import { subDays } from "date-fns";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateSuspiciousFirstPostPhrase extends UserEvaluatorBase {
    override name = "Suspicious First Post Phrase";
    override shortname = "suspiciousfirstpostphrase";

    override banContentThreshold = 1;

    private postContainsPhrase (post: Post): boolean {
        if (!post.body) {
            this.setReason("Post has no body.");
            return false;
        }

        const ignoredSubreddits = this.getVariable<string[]>("ignoredsubreddits", []);
        if (ignoredSubreddits.includes(post.subredditName)) {
            this.setReason(`Post is in ignored subreddit: ${post.subredditName}`);
            return false;
        }

        const phrases = this.getVariable<string[]>("phrases", []);
        const regexes = phrases.map(phrase => new RegExp(`\b${phrase}\b`, "i"));
        const phraseMatched = regexes.find(regex => post.body && regex.test(post.body));
        if (phraseMatched) {
            this.hitReason = `Post contains phrase: ${phraseMatched}`;
            return true;
        } else {
            this.setReason("Post does not contain any of the specified phrases.");
            return false;
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    override preEvaluatePost (post: Post): boolean {
        return this.postContainsPhrase(post);
    }

    override preEvaluateUser (user: UserExtended): boolean {
        const maxAgeInDays = this.getVariable<number>("maxageindays", 180);
        const maxCommentKarma = this.getVariable<number>("maxcommentkarma", 50);
        return user.createdAt > subDays(new Date(), maxAgeInDays) && user.commentKarma < maxCommentKarma;
    }

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
        const posts = this.getPosts(history, { omitRemoved: false });
        if (posts.length === 0) {
            this.setReason("User has no posts.");
            return false;
        }

        const earliestPost = posts[posts.length - 1];

        return this.postContainsPhrase(earliestPost);
    }
}
