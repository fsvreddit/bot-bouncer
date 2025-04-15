import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateSecretLinksBot extends UserEvaluatorBase {
    override name = "Secret Links Bot";
    override shortname = "secretlinks";
    override banContentThreshold = 1;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (_: Post): boolean {
        return false;
    }

    override preEvaluateUser (user: UserExtended): boolean {
        const regexText = `secretlinks.me.${user.username}$`;
        return user.commentKarma < 2500 && new RegExp(regexText).test(user.userDescription ?? "");
    }

    override evaluate (user: UserExtended, history: (Post | Comment)[]): boolean {
        const posts = this.getPosts(history);
        const comments = this.getComments(history);
        return posts.some(post => post.stickied)
            || comments.some(comment => comment.isDistinguished() && comment.subredditName === `u_${user.username}`);
    }
}
