import { CommentCreate, CommentUpdate } from "@devvit/protos";
import { Comment, Post, TriggerContext } from "@devvit/public-api";
import { UserExtended } from "../extendedDevvit.js";

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

    public hitReason: string | undefined = undefined;

    abstract preEvaluateComment (event: CommentCreate): boolean;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public preEvaluateCommentEdit (event: CommentUpdate): boolean {
        return false;
    }

    abstract preEvaluatePost (post: Post): boolean;

    abstract preEvaluateUser (user: UserExtended): boolean | Promise<boolean>;

    abstract evaluate (user: UserExtended, history: (Post | Comment)[]): boolean | Promise<boolean>;
}
