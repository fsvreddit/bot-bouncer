import { CommentCreate, CommentUpdate } from "@devvit/protos";
import { Comment, Post, TriggerContext } from "@devvit/public-api";
import { UserExtended } from "../extendedDevvit.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";

interface HistoryOptions {
    since?: Date;
    omitRemoved?: boolean;
    edited?: boolean;
}

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

    private getContent (history: (Post | Comment)[], options?: HistoryOptions): (Post | Comment)[] {
        const filteredHistory = history.filter((item) => {
            if (options?.since && item.createdAt < options.since) {
                return false;
            }
            if (options?.omitRemoved && item.body === "[removed]") {
                return false;
            }
            if (options?.edited !== undefined) {
                return item.edited === options.edited;
            }
            return true;
        });
        return filteredHistory;
    }

    protected getComments (history: (Post | Comment)[], options?: HistoryOptions): Comment[] {
        const filteredHistory = this.getContent(history, options);
        return filteredHistory.filter(item => isCommentId(item.id)) as Comment[];
    }

    protected getPosts (history: (Post | Comment)[], options?: HistoryOptions): Post[] {
        const filteredHistory = this.getContent(history, options);
        return filteredHistory.filter(item => isLinkId(item.id)) as Post[];
    }
}
