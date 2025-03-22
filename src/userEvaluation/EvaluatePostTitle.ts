import { Comment, Post, User } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";

export class EvaluatePostTitle extends UserEvaluatorBase {
    override name = "Bad Post Title Bot";
    override killswitch = "posttitle:killswitch";
    override banContentThreshold = 1;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    override preEvaluatePost (post: Post): boolean {
        const bannableTitles = this.variables["posttitle:bantext"] as string[] | undefined ?? [];
        const reportableTitles = this.variables["posttitle:reporttext"] as string[] | undefined ?? [];
        const problematicTitles = [...bannableTitles, ...reportableTitles];
        return problematicTitles.some(title => new RegExp(title).test(post.title));
    }

    override preEvaluateUser (user: User): boolean {
        const bannableTitles = this.variables["pinnedpost:bantext"] as string[] | undefined ?? [];
        const reportableTitles = this.variables["pinnedpost:reporttext"] as string[] | undefined ?? [];

        if (bannableTitles.length === 0 && reportableTitles.length === 0) {
            return false;
        }

        if (user.commentKarma > 2000 || user.linkKarma > 2000) {
            return false;
        }
        return true;
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            this.setReason("User does not meet pre-evaluation criteria");
            return false;
        }

        const userPosts = history.filter(item => item instanceof Post && item.stickied) as Post[];
        if (userPosts.length === 0) {
            this.setReason("User has no posts");
            return false;
        }

        const bannableTitles = this.variables["pinnedpost:bantext"] as string[] | undefined ?? [];
        const bannableStickyPosts = userPosts.filter(post => bannableTitles.some(regex => new RegExp(regex).test(post.title)));
        if (bannableStickyPosts.length > 0) {
            this.canAutoBan = true;
            return true;
        }

        const reportableTitles = this.variables["pinnedpost:reporttext"] as string[] | undefined ?? [];
        const reportableStickyPosts = userPosts.filter(post => reportableTitles.some(regex => new RegExp(regex).test(post.title)));
        if (reportableStickyPosts.length > 0) {
            this.canAutoBan = false;
            return true;
        }

        return false;
    }
}
