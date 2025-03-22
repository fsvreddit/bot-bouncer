import { Comment, Post, User } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId } from "@devvit/shared-types/tid.js";
import { subYears } from "date-fns";
import { domainFromUrl } from "./evaluatorHelpers.js";

export class EvaluateResumeSpam extends UserEvaluatorBase {
    override name = "Resume Spam";
    override killswitch = "resume:killswitch";

    private eligibleComment (comment: Comment | CommentV2) {
        if (isCommentId(comment.parentId)) {
            return false;
        }

        return true;
    }

    private eligiblePost (post: Post) {
        const redditDomains = this.variables["generic:redditdomains"] as string[] | undefined ?? [];
        const domain = domainFromUrl(post.url);
        return domain && redditDomains.includes(domain);
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment || !event.author) {
            return false;
        }

        return this.eligibleComment(event.comment);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (post: Post): boolean {
        return false;
    }

    override preEvaluateUser (user: User): boolean {
        if (user.commentKarma > 500) {
            this.setReason("User has too much karma");
            return false;
        }

        if (user.linkKarma > 500) {
            this.setReason("User has too much karma");
            return false;
        }

        if (user.createdAt < subYears(new Date(), 1)) {
            this.setReason("Account is too old");
            return false;
        }

        return true;
    }

    override evaluate (_: User, history: (Post | Comment)[]): boolean {
        const userPosts = history.filter(item => item instanceof Post) as Post[];
        if (userPosts.some(post => !this.eligiblePost(post))) {
            this.setReason("User has ineligible posts");
            return false;
        }

        const userComments = history.filter(item => item instanceof Comment) as Comment[];

        const phrases = this.variables["resume:phrases"] as string[] | undefined;
        if (!phrases) {
            this.setReason("No resume phrases defined");
            return false;
        }

        if (!userComments.some(comment => comment.body.includes("https://") && phrases.some(phrase => comment.body.includes(phrase)))) {
            this.setReason("User does not have resume phrases in comments");
            return false;
        }

        return true;
    }
}
