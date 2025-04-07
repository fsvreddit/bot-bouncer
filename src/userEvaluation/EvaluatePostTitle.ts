import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { UserExtended } from "../extendedDevvit.js";
import markdownEscape from "markdown-escape";

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

    override preEvaluateUser (user: UserExtended): boolean {
        const { bannableTitles, reportableTitles } = this.getTitles();

        if (bannableTitles.length === 0 && reportableTitles.length === 0) {
            return false;
        }

        if (user.commentKarma > 2000 || user.linkKarma > 2000) {
            return false;
        }
        return true;
    }

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
        const userPosts = this.getPosts(history);
        if (userPosts.length === 0) {
            this.setReason("User has no posts");
            return false;
        }

        const { bannableTitles, reportableTitles } = this.getTitles();

        const matchedBanRegex = bannableTitles.find(title => userPosts.some(post => new RegExp(title).test(post.title)));
        if (matchedBanRegex) {
            this.hitReason = `Post title matched bannable regex: ${markdownEscape(matchedBanRegex)}`;
            this.canAutoBan = true;
            return true;
        }

        const matchedReportRegex = reportableTitles.find(title => userPosts.some(post => new RegExp(title).test(post.title)));
        if (matchedReportRegex) {
            this.hitReason = `Post title matched reportable regex: ${markdownEscape(matchedReportRegex)}`;
            this.canAutoBan = false;
            return true;
        }

        return false;
    }
}
