import { Comment, Post, TriggerContext, User } from "@devvit/public-api";

export abstract class UserEvaluatorBase {
    protected username: string;
    protected context: TriggerContext;
    protected user: User;
    protected userHistory: (Post | Comment)[];

    public constructor (username: string, user: User, history: (Post | Comment)[], context: TriggerContext) {
        this.username = username;
        this.context = context;
        this.user = user;
        this.userHistory = history;
    }

    abstract getName (): string;

    abstract evaluate (): boolean;
}
