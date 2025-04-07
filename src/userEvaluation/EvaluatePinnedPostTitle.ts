import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { domainFromUrl } from "../utility.js";
import { UserExtended } from "../extendedDevvit.js";
import markdownEscape from "markdown-escape";

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

    override preEvaluateUser (user: UserExtended): boolean {
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

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
        const stickyPosts = this.getPosts(history).filter(post => post.stickied);
        if (stickyPosts.length === 0) {
            this.setReason("User has no sticky posts");
            return false;
        }

        const bannableTitles = this.variables["pinnedpost:bantext"] as string[] | undefined ?? [];
        const matchedBanRegex = bannableTitles.find(title => stickyPosts.some(post => new RegExp(title).test(post.title)));
        if (matchedBanRegex) {
            this.hitReason = `Sticky post title matched regex: ${markdownEscape(matchedBanRegex)}`;
            this.canAutoBan = true;
            return true;
        }

        const reportableTitles = this.variables["pinnedpost:reporttext"] as string[] | undefined ?? [];
        const matchedReportRegex = reportableTitles.find(title => stickyPosts.some(post => new RegExp(title).test(post.title)));
        if (matchedReportRegex) {
            this.hitReason = `Sticky post title matched regex: ${markdownEscape(matchedReportRegex)}`;
            this.canAutoBan = false;
            return true;
        }

        return false;
    }
}
