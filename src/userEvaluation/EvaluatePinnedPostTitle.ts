import { Comment, Post, User } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { domainFromUrl } from "../utility.js";

export class EvaluatePinnedPostTitles extends UserEvaluatorBase {
    override name = "Sticky Post Title Bot";
    override killswitch = "pinnedpost:killswitch";
    override banContentThreshold = 1;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    override preEvaluatePost (post: Post): boolean {
        const domain = domainFromUrl(post.url);
        return domain === "reddit.com";
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
