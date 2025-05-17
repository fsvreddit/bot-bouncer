import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { UserExtended } from "../extendedDevvit.js";
import { domainFromUrl } from "./evaluatorHelpers.js";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";

export class EvaluateAmazonSpam extends UserEvaluatorBase {
    override name = "Amazon Spam";
    override shortname = "amazonspam";

    public override banContentThreshold = 1;

    private isEligiblePost (post: Post): boolean {
        const domain = domainFromUrl(post.url);
        return domain === "v.redd.it" || post.subredditName === `u_${post.authorName}`;
    }

    private isEligibleComment (comment: Comment | CommentV2): boolean {
        const regex = /^\[[A-Za-z ]+\]\(https:\/\/amzn.to\/[\w\d]+\)$/;
        return regex.test(comment.body);
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment) {
            return false;
        }
        return this.isEligibleComment(event.comment);
    }

    override preEvaluatePost (post: Post): boolean {
        return this.isEligiblePost(post);
    }

    override preEvaluateUser (user: UserExtended): boolean {
        return user.commentKarma < this.getVariable<number>("maxcommentkarma", 100);
    }

    override evaluate (_user: UserExtended, history: (Post | Comment)[]): boolean {
        const posts = this.getPosts(history);
        if (posts.length === 0) {
            this.setReason("No posts in user history");
            return false;
        }

        if (!posts.every(post => this.isEligiblePost(post))) {
            this.setReason("Not all posts are eligible");
            return false;
        }

        const comments = this.getComments(history);
        if (comments.length === 0) {
            this.setReason("No comments in user history");
            return false;
        }

        if (!comments.every(comment => this.isEligibleComment(comment))) {
            this.setReason("Not all comments are eligible");
            return false;
        }

        return true;
    }
}
