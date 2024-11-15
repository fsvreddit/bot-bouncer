import { TriggerContext } from "@devvit/public-api";

export abstract class UserEvaluatorBase {
    protected username: string;
    protected context: TriggerContext;

    public constructor (username: string, context: TriggerContext) {
        this.username = username;
        this.context = context;
    }

    abstract getName (): string;

    abstract evaluate (): Promise<boolean>;
}
