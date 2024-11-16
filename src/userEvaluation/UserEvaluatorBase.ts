import { CommentSubmit } from "@devvit/protos";
import { Comment, Post, TriggerContext, User } from "@devvit/public-api";

export abstract class UserEvaluatorBase {
    abstract getName (): string;

    abstract preEvaluateComment (event: CommentSubmit): boolean;

    abstract preEvaluatePost (post: Post): boolean;

    abstract evaluate (user: User, history: (Post | Comment)[], context?: TriggerContext): boolean;
}
