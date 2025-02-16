import { Comment, Post, User } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { isCommentId } from "@devvit/shared-types/tid.js";
import { subWeeks } from "date-fns";
import { countBy } from "lodash";
import { domainFromUrl } from "../utility.js";

export class EvaluateSelfLoveBot extends UserEvaluatorBase {
    override name = "Self Love Bot";
    override banContentThreshold = 8;

    private eligibleComment (comment: Comment | CommentV2) {
        if (isCommentId(comment.parentId)) {
            return false;
        }

        return !comment.body.includes("\n")
            && comment.body.length < 250
            && comment.body.length > 20;
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment || !event.author) {
            return false;
        }

        if (!this.usernameMatchesBotPatterns(event.author.name)) {
            return false;
        }

        return this.eligibleComment(event.comment);
    }

    private eligiblePost (post: Post): boolean {
        const domain = domainFromUrl(post.url);
        return domain === "i.redd.it";
    }

    override preEvaluatePost (post: Post): boolean {
        if (!this.usernameMatchesBotPatterns(post.authorName)) {
            return false;
        }

        return this.eligiblePost(post);
    }

    override preEvaluateUser (user: User): boolean {
        if (user.commentKarma > 500) {
            this.setReason("User has too much karma");
            return false;
        }

        if (user.createdAt < subWeeks(new Date(), 6)) {
            this.setReason("Account is too old");
            return false;
        }

        return this.usernameMatchesBotPatterns(user.username);
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            return false;
        }

        if (this.variables["selflove:killswitch"]) {
            this.setReason("Evaluator is disabled");
            return false;
        }

        const userComments = history.filter(item => item instanceof Comment) as Comment[];

        if (userComments.length < 5) {
            this.setReason("User doesn't have enough comments");
            return false;
        }

        if (!userComments.every(comment => this.eligibleComment(comment))) {
            this.setReason("Mis-matching comment");
            return false;
        }

        const lowerCaseComments = userComments.filter(comment => comment.body === comment.body.toLowerCase()).length;
        const lowerCaseRatio = this.variables["selflove:lowercaseratio"] as number | undefined ?? 0.4;
        if (lowerCaseComments / userComments.length < lowerCaseRatio) {
            this.setReason("User has insufficient non-lowercase comments");
            return false;
        }

        if (lowerCaseComments === userComments.length) {
            this.setReason("User has only lowercase comments");
            return false;
        }

        if (userComments.some(comment => comment.edited)) {
            this.setReason("User has edited comments");
            return false;
        }

        const commentsPerPost = countBy(userComments.map(comment => comment.postId));
        if (Object.values(commentsPerPost).some(count => count > 1)) {
            this.setReason("User has multiple comments on a post");
            return false;
        }

        const userPosts = history.filter(item => item instanceof Post) as Post[];
        if (userPosts.length === 0) {
            this.setReason("User has no posts");
            return false;
        }

        if (!userPosts.every(post => this.eligiblePost(post))) {
            this.setReason("Non-matching post");
            return false;
        }

        return true;
    }

    private usernameMatchesBotPatterns (username: string): boolean {
        const botUsernameRegexes = this.variables["selflove:usernames"] as string[] | undefined ?? [];
        const regexes = botUsernameRegexes.map(regex => new RegExp(regex));

        return regexes.some(regex => regex.test(username));
    }
}
