import { TriggerContext } from "@devvit/public-api";

export abstract class UserEvaluatorBase {
    public name = "";
    protected username: string;
    protected context: TriggerContext;

    public constructor (username: string, context: TriggerContext) {
        this.username = username;
        this.context = context;
    }

    abstract evaluate (): Promise<boolean>;
}
