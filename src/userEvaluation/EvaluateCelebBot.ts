import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post, User } from "@devvit/public-api";
import { getHours, subMonths } from "date-fns";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { autogenRegex, domainFromUrl } from "./evaluatorHelpers.js";
import { uniq } from "lodash";

export class EvaluateCelebBot extends UserEvaluatorBase {
    override name = "Celeb Bot"; // Why this? It always has old-school celeb pictures in the post history.
    override banContentThreshold = 20;
    override canAutoBan = false;

    private eligibleComment (comment: Comment | CommentV2): boolean {
        const selfPostSubs = this.variables["celeb:allowedselfpostsubs"] as string[] | undefined ?? [];

        if (comment instanceof Comment && selfPostSubs.includes(comment.subredditName)) {
            return true;
        }

        const eligibleComment = comment.body.length < 1200 && !comment.body.includes("\n") && isLinkId(comment.parentId);

        return eligibleComment;
    }

    private eligiblePost (post: Post): boolean {
        const selfPostSubs = this.variables["celeb:allowedselfpostsubs"] as string[] | undefined ?? [];
        const domain = domainFromUrl(post.url);

        return selfPostSubs.includes(post.subredditName)
            || domain === "i.redd.it";
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment) {
            return false;
        }

        return this.eligibleComment(event.comment);
    }

    override preEvaluatePost (post: Post): boolean {
        return this.eligiblePost(post);
    }

    override preEvaluateUser (user: User): boolean {
        return user.createdAt > subMonths(new Date(), 18)
            && user.linkKarma < 10000
            && user.commentKarma < 2000
            && autogenRegex.test(user.username);
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            this.setReason("User is too old or has too much karma");
            return false;
        }

        const posts = history.filter(item => isLinkId(item.id) && item.body !== "[removed]") as Post[];
        if (!posts.every(post => this.eligiblePost(post))) {
            this.setReason("User has non-eligible posts");
            return false;
        }

        const mandatorySubs = this.variables["celeb:mandatorysubs"] as string[] | undefined ?? [];
        if (!posts.some(post => mandatorySubs.includes(post.subredditName))) {
            this.setReason("User has no posts in mandatory subs");
            return false;
        }

        const extraSubs = this.variables["celeb:extrasubs"] as string[] | undefined ?? [];
        const extraSubCount = this.variables["celeb:extrasubcount"] as number | undefined ?? 2;

        const extraSubNames = uniq(posts.filter(post => extraSubs.includes(post.subredditName)).map(post => post.subredditName));
        if (extraSubNames.length < extraSubCount) {
            this.setReason("User has insufficient posts in extra subs");
            return false;
        }

        const comments = history.filter(item => isCommentId(item.id)) as Comment[];

        if (comments.length < 10) {
            this.setReason("User has insufficient comments to check user");
            return false;
        }

        if (!comments.every(comment => this.eligibleComment(comment))) {
            this.setReason("User has non-eligible comments");
            return false;
        }

        const contentHours = uniq(history.map(item => getHours(item.createdAt)));
        if (contentHours.length < 24) {
            this.setReason("User has not posted in every hour of the day");
            return false;
        }

        return true;
    }
}
