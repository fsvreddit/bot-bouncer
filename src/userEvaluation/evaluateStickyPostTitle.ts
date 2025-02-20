import { Comment, Post, User } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";

export class EvaluateBannedTitles extends UserEvaluatorBase {
    override name = "Sticky Post Title Bot";
    override banContentThreshold = 1;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (_: Post): boolean {
        return false;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateUser (_: User): boolean {
        return true;
    }

    override evaluate (_: User, history: (Post | Comment)[]): boolean {
        const stickyPosts = history.filter(item => item instanceof Post && item.stickied) as Post[];
        if (stickyPosts.length === 0) {
            this.setReason("User has no sticky posts");
            return false;
        }

        const bannableTitles = this.variables["pinnedpost:bantext"] as string[] | undefined ?? [];
        const bannableStickyPosts = stickyPosts.filter(post => bannableTitles.some(regex => new RegExp(regex).test(post.title)));
        if (bannableStickyPosts.length > 0) {
            this.canAutoBan = true;
            return true;
        }

        const reportableTitles = this.variables["pinnedpost:reporttext"] as string[] | undefined ?? [];
        const reportableStickyPosts = stickyPosts.filter(post => reportableTitles.some(regex => new RegExp(regex).test(post.title)));
        if (reportableStickyPosts.length > 0) {
            this.canAutoBan = false;
            return true;
        }

        return false;
    }
}
