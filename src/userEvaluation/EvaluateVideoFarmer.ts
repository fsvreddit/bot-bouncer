import { Comment, Post, User } from "@devvit/public-api";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { CommentCreate } from "@devvit/protos";
import { domainFromUrl } from "./evaluatorHelpers.js";
import { differenceInMinutes, subMonths } from "date-fns";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { uniq } from "lodash";

export class EvaluateVideoFarmer extends UserEvaluatorBase {
    override name = "Video Farmer";

    private isEligiblePost (post: Post): boolean {
        return domainFromUrl(post.url) === "v.redd.it";
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    override preEvaluatePost (post: Post): boolean {
        return this.isEligiblePost(post);
    }

    override preEvaluateUser (user: User): boolean {
        if (user.commentKarma > 5) {
            this.setReason("User has too much comment karma");
            return false;
        }

        if (user.createdAt < subMonths(new Date(), 3)) {
            this.setReason("Account is too old");
            return false;
        }

        return false;
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            return false;
        }

        const userComments = history.filter(item => isCommentId(item.id)) as Comment[];
        if (userComments.length > 5) {
            this.setReason("Too many comments");
            return false;
        }

        if (userComments.some(comment => comment.body.includes("\n"))) {
            this.setReason("Comments with line breaks");
            return false;
        }

        if (userComments.some(comment => comment.body.length > 200)) {
            this.setReason("User has comments that are too long.");
            return false;
        }

        const userPosts = history.filter(item => isLinkId(item.id)) as Post[];

        if (userPosts.length < 3 || userPosts.length > 5) {
            this.setReason("User has the wrong number of posts");
            return false;
        }

        if (!userPosts.every(post => this.isEligiblePost(post))) {
            this.setReason("User has non-matching posts");
            return false;
        }

        const uniqueDomains = uniq(userPosts.map(post => post.subredditName));
        if (uniqueDomains.length > 1) {
            this.setReason("User has posts from more than one subreddit");
            return false;
        }

        if (differenceInMinutes(userPosts[0].createdAt, userPosts[2].createdAt) > 20) {
            this.setReason("Posts are too far apart");
            return false;
        }

        return true;
    }
}
