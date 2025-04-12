import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post } from "@devvit/public-api";
import { addMinutes, subDays } from "date-fns";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { domainFromUrl } from "./evaluatorHelpers.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateSelfComment extends UserEvaluatorBase {
    override name = "Self Comment";
    override shortname = "selfcomment";

    override banContentThreshold = 2;

    private isSubIgnored () {
        const ignoredSubreddits = this.variables["selfcomment:ignoredsubs"] as string[] | undefined ?? [];
        return this.context.subredditName && ignoredSubreddits.includes(this.context.subredditName);
    }

    private eligibleComment (comment: Comment | CommentV2): boolean {
        return isLinkId(comment.parentId)
            && comment.body.split("\n\n").length <= 2;
    }

    private eligiblePost (post: Post): boolean {
        const domain = domainFromUrl(post.url);
        const karmaFarmingSubs = this.variables["generic:karmafarminglinksubs"] as string[] | undefined ?? [];
        return (domain === "i.redd.it" || domain === "v.redd.it") && !post.nsfw && karmaFarmingSubs.includes(post.subredditName);
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (this.isSubIgnored()) {
            return false;
        }

        if (!event.comment) {
            return false;
        }
        return this.eligibleComment(event.comment);
    }

    override preEvaluatePost (post: Post): boolean {
        if (this.isSubIgnored()) {
            return false;
        }

        return this.eligiblePost(post);
    }

    override preEvaluateUser (user: UserExtended): boolean {
        const ageInDays = this.variables["selfcomment:ageindays"] as number | undefined ?? 14;
        const maxKarma = this.variables["selfcomment:maxkarma"] as number | undefined ?? 500;
        return user.createdAt > subDays(new Date(), ageInDays) && user.commentKarma < maxKarma;
    }

    override evaluate (user: UserExtended, history: (Post | Comment)[]): boolean {
        const ignoredSubreddits = this.variables["selfcomment:ignoredsubs"] as string[] | undefined ?? [];
        ignoredSubreddits.push(...history.filter(item => item.subredditName.toLowerCase().includes("onlyfans")).map(item => item.subredditName));

        const posts = this.getPosts(history, { omitRemoved: true });
        if (posts.length === 0 || !posts.every(post => this.eligiblePost(post))) {
            this.setReason("User has missing or mismatching posts");
            return false;
        }

        const comments = this.getComments(history);
        if (comments.length === 0 || !comments.every(comment => this.eligibleComment(comment))) {
            this.setReason("User has missing or mismatching comments");
            return false;
        }

        if (!posts.some(post => comments.some(comment => comment.parentId === post.id && !ignoredSubreddits.includes(post.subredditName)))) {
            this.setReason("User has no posts with self comments");
            return false;
        }

        const maxCommentAge = this.variables["selfcomment:commentmaxminutes"] as number | undefined ?? 1;
        for (const comment of comments.filter(comment => !ignoredSubreddits.includes(comment.subredditName))) {
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
