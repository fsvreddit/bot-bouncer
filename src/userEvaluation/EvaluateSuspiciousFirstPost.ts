import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post } from "@devvit/public-api";
import { subDays } from "date-fns";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { domainFromUrl } from "./evaluatorHelpers.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateSuspiciousFirstPost extends UserEvaluatorBase {
    override name = "Suspicious First Post";
    override killswitch = "suspiciousfirstpost:killswitch";

    override banContentThreshold = 1;

    private subList () {
        return this.variables["suspiciousfirstpost:subreddits"] as string[] | undefined ?? [];
    }

    private eligiblePost (post: Post): boolean {
        if (!this.subList().includes(post.subredditName)) {
            return false;
        }

        const domain = domainFromUrl(post.url);
        return domain === "i.redd.it" || domain === "v.redd.it";
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    override preEvaluatePost (post: Post): boolean {
        return this.eligiblePost(post);
    }

    override preEvaluateUser (user: UserExtended): boolean {
        const maxAgeInDays = this.variables["suspiciousfirstpost:maxageindays"] as number | undefined ?? 14;
        return user.createdAt > subDays(new Date(), maxAgeInDays) && user.commentKarma < 5;
    }

    override evaluate (user: UserExtended, history: (Post | Comment)[]): boolean {
        if (history.some(item => isCommentId(item.id))) {
            this.setReason("User has made comments.");
            return false;
        }

        const posts = history.filter(item => isLinkId(item.id) && item.body !== "[removed]") as Post[];
        if (posts.length === 0) {
            this.setReason("User has no posts.");
            return false;
        }

        if (posts.length > 1) {
            this.setReason("User has multiple posts.");
            return false;
        }
        if (!posts.every(post => this.eligiblePost(post))) {
            this.setReason("User has missing or mismatching posts.");
            return false;
        }

        return true;
    }
}
