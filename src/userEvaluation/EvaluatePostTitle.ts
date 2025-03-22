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

    private getTitles () {
        const bannableTitles = this.variables["posttitle:bantext"] as string[] | undefined ?? [];
        const reportableTitles = this.variables["posttitle:reporttext"] as string[] | undefined ?? [];
        return { bannableTitles, reportableTitles };
    }

    override preEvaluatePost (post: Post): boolean {
        const { bannableTitles, reportableTitles } = this.getTitles();
        const problematicTitles = [...bannableTitles, ...reportableTitles];
        return problematicTitles.some(title => new RegExp(title).test(post.title));
    }

    override preEvaluateUser (user: User): boolean {
        const { bannableTitles, reportableTitles } = this.getTitles();

        if (bannableTitles.length === 0 && reportableTitles.length === 0) {
            return false;
        }

        if (user.commentKarma > 2000 || user.linkKarma > 2000) {
            return false;
        }
        return true;
    }

    override evaluate (_: User, history: (Post | Comment)[]): boolean {
        const userPosts = history.filter(item => item instanceof Post && item.stickied) as Post[];
        if (userPosts.length === 0) {
            this.setReason("User has no posts");
            return false;
        }

        const { bannableTitles, reportableTitles } = this.getTitles();

        const bannablePosts = userPosts.filter(post => bannableTitles.some(regex => new RegExp(regex).test(post.title)));
        if (bannablePosts.length > 0) {
            this.canAutoBan = true;
            return true;
        }

        const reportablePosts = userPosts.filter(post => reportableTitles.some(regex => new RegExp(regex).test(post.title)));
        if (reportablePosts.length > 0) {
            this.canAutoBan = false;
            return true;
        }

        return false;
    }
}
