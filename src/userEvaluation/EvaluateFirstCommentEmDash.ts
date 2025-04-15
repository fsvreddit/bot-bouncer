import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { subMonths } from "date-fns";
import { last, uniq } from "lodash";
import { domainFromUrl } from "./evaluatorHelpers.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateFirstCommentEmDash extends UserEvaluatorBase {
    override name = "First Comment Em Dash";
    override shortname = "em-dash";

    override banContentThreshold = 1;

    private readonly emDashRegex = /\w—\w/i;

    private isNoCheckSub () {
        const noCheckSubs = this.getVariable<string[]>("nochecksubs", []);
        return this.context.subredditName && noCheckSubs.includes(this.context.subredditName);
    }

    private eligibleComment (comment: Comment | CommentV2) {
        return isLinkId(comment.parentId);
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment) {
            return false;
        }

        if (this.isNoCheckSub()) {
            return false;
        }

        return this.eligibleComment(event.comment);
    }

    private eligiblePost (post: Post): boolean {
        const domain = domainFromUrl(post.url);
        const redditDomains = this.getGenericVariable<string[]>("redditdomains", []);

        return domain !== undefined && redditDomains.includes(domain);
    }

    override preEvaluatePost (post: Post): boolean {
        if (this.isNoCheckSub()) {
            return false;
        }

        return this.eligiblePost(post);
    }

    override preEvaluateUser (user: UserExtended): boolean {
        if (user.createdAt < subMonths(new Date(), 2)) {
            this.setReason("Account is too old");
            return false;
        }

        if (this.isNoCheckSub()) {
            return false;
        }

        return true;
    }

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
        const comments = this.getComments(history);
        const posts = this.getPosts(history);

        if (comments.length > 30) {
            this.canAutoBan = false;
            return false;
        }

        if (comments.length === 0) {
            this.setReason("User has no comments");
            return false;
        }

        if (comments.some(comment => !this.eligibleComment(comment))) {
            this.setReason("User has non-toplevel comments");
            return false;
        }

        if (comments.some(comment => posts.some(post => post.id === comment.parentId))) {
            this.setReason("User has comments on their own posts");
            return false;
        }

        const firstComment = last(comments);
        const firstCommentContainsEmDash = firstComment ? this.emDashRegex.test(firstComment.body) : false;

        let emDashThreshold: number;
        if (comments.length > 80) {
            emDashThreshold = 0.2;
        } else if (comments.length > 30) {
            emDashThreshold = 0.25;
        } else {
            emDashThreshold = 0.3;
        }

        const emDashThresholdMet = comments.filter(comment => this.emDashRegex.test(comment.body)).length / comments.length > emDashThreshold;

        if (!firstCommentContainsEmDash && !emDashThresholdMet) {
            this.setReason("User's first comment doesn't contain an em dash, or they have insufficient comments with them");

            const karmaFarmingSubs = this.getGenericVariable<string[]>("karmafarminglinksubs", []);
            const postCountNeeded = this.getVariable<number>("postcount", 3);
            const subsNeeded = this.getVariable<number>("distinctsubs", 3);

            const backupRequirementsMet = posts.length >= postCountNeeded
                && uniq(posts.filter(post => karmaFarmingSubs.includes(post.subredditName)).map(post => post.subredditName)).length >= subsNeeded
                && comments.filter(comment => comment.body.includes("—")).length > 1;

            if (!backupRequirementsMet) {
                return false;
            }
        }

        if (posts.length > 0 && posts.some(post => !this.eligiblePost(post))) {
            this.setReason("User has non-matching posts");
            return false;
        }

        const noAutoBanSubs = this.getVariable<string[]>("noautobansubs", []);
        if (history.some(item => noAutoBanSubs.includes(item.subredditName))) {
            this.canAutoBan = false;
        }

        return true;
    }
}
