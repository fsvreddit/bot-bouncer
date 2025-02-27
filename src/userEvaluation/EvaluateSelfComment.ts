import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post, User } from "@devvit/public-api";
import { addMinutes, subDays } from "date-fns";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { domainFromUrl } from "./evaluatorHelpers.js";

export class EvaluateSelfComment extends UserEvaluatorBase {
    override name = "Self Comment";

    override banContentThreshold = 2;

    private eligibleComment (comment: Comment | CommentV2): boolean {
        return isLinkId(comment.parentId)
            && comment.body.split("\n\n").length <= 2;
    }

    private eligiblePost (post: Post): boolean {
        const domain = domainFromUrl(post.url);
        return domain === "i.redd.it" || domain === "v.redd.it";
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
        if (this.variables["selfcomment:killswitch"]) {
            return false;
        }

        const ageInDays = this.variables["selfcomment:ageindays"] as number | undefined ?? 14;
        const maxKarma = this.variables["selfcomment:maxkarma"] as number | undefined ?? 500;
        return user.createdAt < subDays(new Date(), ageInDays) && user.commentKarma < maxKarma;
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            return false;
        }

        if (this.variables["selfcomment:killswitch"]) {
            this.setReason("Killswitch enabled");
            return false;
        }

        const posts = history.filter(item => isLinkId(item.id) && item.body !== "[removed]") as Post[];
        if (posts.length === 0 || !posts.every(post => this.eligiblePost(post))) {
            this.setReason("User has missing or mismatching posts");
        }

        const comments = history.filter(item => isCommentId(item.id)) as Comment[];
        if (comments.length === 0 || !comments.every(comment => this.eligibleComment(comment))) {
            this.setReason("User has missing or mismatching comments");
        }

        if (posts.some(post => !comments.some(comment => comment.parentId === post.id))) {
            this.setReason("User has posts without self comments");
        }

        const maxCommentAge = this.variables["selfcomment:commentmaxminutes"] as number | undefined ?? 1;
        for (const comment of comments) {
            const post = posts.find(post => post.id === comment.parentId);
            if (!post || post.authorId !== user.id) {
                this.setReason("Comment on someone else's post");
                return false;
            }

            if (comment.createdAt > addMinutes(post.createdAt, maxCommentAge)) {
                this.setReason("Comment is too long after post creation");
                return false;
            }
        }

        return true;
    }
}
