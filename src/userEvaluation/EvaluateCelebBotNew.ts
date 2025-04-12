import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { subDays } from "date-fns";
import { UserExtended } from "../extendedDevvit.js";
import { domainFromUrl } from "./evaluatorHelpers.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { uniq } from "lodash";

export class EvaluateCelebBotNew extends UserEvaluatorBase {
    override name = "Celeb Bot New";
    override shortname = "celebbotnew";

    public override banContentThreshold = 5;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    private eligiblePost (post: Post): boolean {
        const domain = domainFromUrl(post.url);
        return domain === "i.imgur.com" || domain === "i.redd.it";
    }

    private eligibleComment (comment: Comment): boolean {
        return comment.body.length < 100
            && !comment.body.includes("\n")
            && isLinkId(comment.parentId);
    }

    override preEvaluatePost (post: Post): boolean {
        return this.eligiblePost(post);
    }

    override preEvaluateUser (user: UserExtended): boolean {
        const usernameRegex = /^(?:[A-Z][a-z]+[-_]?){2}\d{4}$/;
        return user.nsfw
            && usernameRegex.test(user.username)
            && user.createdAt > subDays(new Date(), 28)
            && user.commentKarma < 50;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override evaluate (_user: UserExtended, history: (Post | Comment)[]): boolean {
        const userPosts = this.getPosts(history);
        if (userPosts.length !== 1) {
            this.setReason("User has either no posts or too many posts.");
            return false;
        }

        if (!this.eligiblePost(userPosts[0])) {
            this.setReason("Mismatching post.");
            return false;
        }

        const comments = this.getComments(history);
        if (comments.length !== 4) {
            this.setReason("User has either no comments or too many comments.");
            return false;
        }

        if (!comments.every(comment => this.eligibleComment(comment))) {
            this.setReason("Mismatching comments.");
            return false;
        }

        const commentPosts = uniq(comments.map(comment => comment.postId));
        if (commentPosts.length !== 1) {
            this.setReason("User has comments on multiple posts.");
            return false;
        }

        return true;
    }
}
