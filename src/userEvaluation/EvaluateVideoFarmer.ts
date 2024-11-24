import { Comment, Post, User } from "@devvit/public-api";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { CommentSubmit } from "@devvit/protos";
import { domainFromUrl } from "./evaluatorHelpers.js";
import { differenceInMinutes, subMonths } from "date-fns";
import { isCommentId } from "@devvit/shared-types/tid.js";

export class EvaluateVideoFarmer extends UserEvaluatorBase {
    getName () {
        return "Video Farmer";
    };

    private isEligiblePost (post: Post): boolean {
        return domainFromUrl(post.url) === "v.redd.it"
            && (post.subredditName === this.context.subredditName || post.subredditName === "aww");
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentSubmit): boolean {
        return false;
    }

    override preEvaluatePost (post: Post): boolean {
        return this.isEligiblePost(post);
    }

    override preEvaluateUser (user: User): boolean {
        if (user.commentKarma > 0) {
            this.setReason("User has too much comment karma");
        }

        if (user.createdAt < subMonths(new Date(), 3)) {
            this.setReason("Account is too old");
            return false;
        }

        const usernameRegex = /^[a-z]+[A-Z][a-z]+$/;
        if (!usernameRegex.test(user.username)) {
            this.setReason("Username does not match regex");
            return false;
        }

        const characters = [...user.username];

        for (let x = 0; x < characters.length - 1; x++) {
            if (characters[0] === characters[1]) {
                return true;
            }
        }

        return false;
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            return false;
        }

        if (history.some(item => isCommentId(item.id))) {
            this.setReason("User has comments");
            return false;
        }

        const userPosts = history as Post[];

        if (userPosts.length !== 3) {
            this.setReason("User has the wrong number of posts");
            return false;
        }

        if (!userPosts.every(post => this.isEligiblePost(post))) {
            this.setReason("User has non-matching posts");
            return false;
        }

        if (differenceInMinutes(userPosts[0].createdAt, userPosts[2].createdAt) > 30) {
            this.setReason("Posts are too far apart");
            return false;
        }

        return true;
    }
}
