import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post } from "@devvit/public-api";
import { UserExtended } from "../extendedDevvit.js";
import { subDays } from "date-fns";

export class EvaluateSequencePostBot extends UserEvaluatorBase {
    override name = "Sequence Post Bot";
    override shortname = "sequencepost";
    override banContentThreshold = 2;
    override canAutoBan = true;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    private getSubreddits () {
        return {
            firstPostSubreddits: this.getVariable<string[]>("firstpostsubs", []),
            secondPostSubreddits: this.getVariable<string[]>("secondpostsubs", []),
        };
    }

    override preEvaluatePost (post: Post): boolean {
        const { firstPostSubreddits, secondPostSubreddits } = this.getSubreddits();
        return (firstPostSubreddits.includes(post.subredditName) || secondPostSubreddits.includes(post.subredditName));
    }

    override preEvaluateUser (user: UserExtended): boolean {
        const maxAccountAge = this.getVariable<number>("maxaccountage", 7);
        return user.commentKarma < 50 && user.createdAt > subDays(new Date(), maxAccountAge);
    }

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
        const { firstPostSubreddits, secondPostSubreddits } = this.getSubreddits();
        const posts = this.getPosts(history);
        if (posts.length < 2) {
            this.setReason("User has not made enough posts");
            return false;
        }

        const oldestPost = posts[posts.length - 1];
        const secondOldestPost = posts[posts.length - 2];

        if (oldestPost.subredditName === secondOldestPost.subredditName) {
            this.setReason("User has made posts in the same subreddit twice in a row");
            return false;
        }

        if (!firstPostSubreddits.includes(oldestPost.subredditName) || !secondPostSubreddits.includes(secondOldestPost.subredditName)) {
            this.setReason("User has not made posts in the correct subreddits");
            return false;
        }

        this.hitReason = `Sequence Post Bot: User has made posts in the correct subreddits: ${oldestPost.subredditName} and ${secondOldestPost.subredditName}`;
        return true;
    }
}
