import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { Comment, Post, User } from "@devvit/public-api";
import { subWeeks, subYears } from "date-fns";
import { CommentV2 } from "@devvit/protos/types/devvit/reddit/v2alpha/commentv2.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { autogenRegex } from "./evaluatorHelpers.js";
import { compact, uniq } from "lodash";

export class EvaluateSoccerStreamBot extends UserEvaluatorBase {
    override name = "Soccer Stream Bot";
    override banContentThreshold = 20;
    override canAutoBan = true;

    private subredditFromComment (body: string): string | undefined {
        const regex = /r\/([\w\d-]+)\/wiki\//;
        const matches = regex.exec(body);
        if (matches && matches.length === 2) {
            return matches[1];
        }
    }

    private eligibleComment (comment: Comment | CommentV2): boolean {
        const subreddit = this.subredditFromComment(comment.body);

        return subreddit !== undefined;
    }

    override preEvaluateComment (event: CommentCreate): boolean {
        if (!event.comment) {
            return false;
        }

        return this.eligibleComment(event.comment);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (post: Post): boolean {
        return false;
    }

    override preEvaluateUser (user: User): boolean {
        return user.createdAt > subYears(new Date(), 2)
            && user.linkKarma < 500
            && user.commentKarma < 2000
            && autogenRegex.test(user.username);
    }

    override evaluate (user: User, history: (Post | Comment)[]): boolean {
        if (!this.preEvaluateUser(user)) {
            this.setReason("User does not pass pre-evaluation checks");
            return false;
        }

        if (this.variables["soccerstreams:killswitch"]) {
            this.setReason("Evaluator is disabled");
            return false;
        }

        const posts = history.filter(item => isLinkId(item.id) && item.body !== "[removed]") as Post[];
        if (posts.some(post => post.createdAt > subWeeks(new Date(), 1))) {
            this.setReason("User has non-eligible posts");
            return false;
        }

        const comments = history.filter(item => isCommentId(item.id)) as Comment[];

        if (comments.length < 20) {
            this.setReason("User has insufficient comments to check user");
            return false;
        }

        const commentsWithSubWikiLink = comments.filter(comment => this.subredditFromComment(comment.body) !== undefined);
        if (commentsWithSubWikiLink.length < comments.length * 0.95) {
            this.setReason("User has insufficient comments with subreddit wiki links");
            return false;
        }

        const distinctSubreddits = uniq(compact(commentsWithSubWikiLink.map(comment => this.subredditFromComment(comment.body))));
        if (distinctSubreddits.length > 3) {
            this.setReason("User has too many distinct subreddits in comments");
            return false;
        }

        return true;
    }
}
