import { Comment, Post } from "@devvit/public-api";
import { EvaluateBadUsername } from "./EvaluateBadUsername.js";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateBadUsernameYoung extends EvaluateBadUsername {
    override name = "Bad Username Young Bot";
    override shortname = "badusernameyoung";

    override evaluate (_user: UserExtended, history: (Post | Comment)[]): boolean {
        const allowAnySub = this.getVariable<boolean>("anysub", false);
        if (allowAnySub) {
            return true;
        }

        const subList = this.getVariable<string[]>("sublist", []);
        const contentInConfiguredSubreddits = subList.filter(subredditName => history.some(item => item.subredditName === subredditName));
        if (contentInConfiguredSubreddits.length === 0) {
            this.setReason("User has no content in configured subreddits");
            return true;
        }

        this.hitReason = `User has content in configured subreddits: ${contentInConfiguredSubreddits.join(", ")}`;
        return true;
    }
}
