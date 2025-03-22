import { CommentCreate } from "@devvit/protos";
import { Comment, Post, TriggerContext, User } from "@devvit/public-api";

export abstract class UserEvaluatorBase {
    protected reasons: string[] = [];
    protected context: TriggerContext;
    protected variables: Record<string, unknown> = {};

    abstract name: string;
    abstract killswitch: string;

    public setReason (reason: string) {
        this.reasons.push(reason);
    }

    public getReasons () {
        return this.reasons;
    }

    public banContentThreshold = 10;
    public canAutoBan = true;

    constructor (context: TriggerContext, variables: Record<string, unknown>) {
        this.context = context;
        this.variables = variables;
    }

    public evaluatorDisabled () {
        return this.variables[this.killswitch] as boolean | undefined ?? false;
    }

    abstract preEvaluateComment (event: CommentCreate): boolean;

    abstract preEvaluatePost (post: Post): boolean;

    abstract preEvaluateUser (user: User): boolean;

    abstract evaluate (user: User, history: (Post | Comment)[]): boolean;
}
