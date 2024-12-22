import { CommentSubmit } from "@devvit/protos";
import { Comment, Post, TriggerContext, User } from "@devvit/public-api";

export abstract class UserEvaluatorBase {
    protected reasons: string[] = [];
    protected context: TriggerContext;

    public setReason (reason: string) {
        this.reasons.push(reason);
    }

    public getReasons () {
        return this.reasons;
    }

    public canAutoBan = true;

    constructor (context: TriggerContext) {
        this.context = context;
    }

    abstract getName (): string;

    abstract preEvaluateComment (event: CommentSubmit): boolean;

    abstract preEvaluatePost (post: Post): boolean;

    abstract preEvaluateUser (user: User): boolean;

    abstract evaluate (user: User, history: (Post | Comment)[]): boolean;
}
