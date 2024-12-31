import { CommentSubmit } from "@devvit/protos";
import { Comment, Post, TriggerContext, User } from "@devvit/public-api";

export abstract class UserEvaluatorBase {
    protected reasons: string[] = [];
    protected context: TriggerContext;

    abstract name: string;

    public setReason (reason: string) {
        this.reasons.push(reason);
    }

    public getReasons () {
        return this.reasons;
    }

    public banContentThreshold = 10;
    public canAutoBan = true;

    constructor (context: TriggerContext) {
        this.context = context;
    }

    abstract preEvaluateComment (event: CommentSubmit): boolean;

    abstract preEvaluatePost (post: Post): boolean;

    abstract preEvaluateUser (user: User): boolean;

    abstract evaluate (user: User, history: (Post | Comment)[]): boolean;
}
