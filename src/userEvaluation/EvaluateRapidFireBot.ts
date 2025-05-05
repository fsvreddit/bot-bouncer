import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { subDays, subMinutes, subMonths } from "date-fns";
import { UserExtended } from "../extendedDevvit.js";

export class EvaluateRapidFireBot extends UserEvaluatorBase {
    override name = "Rapid Fire Bot";
    override shortname = "rapidfire";
    override banContentThreshold = 5;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluatePost (_: Post): boolean {
        return true;
    }

    override preEvaluateUser (user: UserExtended): boolean {
        if (user.commentKarma > this.getVariable<number>("maxcommentkarma", 500)) {
            this.setReason("User has too much karma");
            return false;
        }

        if (user.linkKarma > this.getVariable<number>("maxpostkarma", 500)) {
            this.setReason("User has too much karma");
            return false;
        }

        if (user.createdAt < subDays(new Date(), this.getVariable<number>("maxaccountageindays", 28))) {
            this.setReason("Account is too old");
            return false;
        }

        return true;
    }

    override evaluate (_: UserExtended, history: (Post | Comment)[]): boolean {
        const sortedHistory = [...history.filter(item => item.createdAt > subMonths(new Date(), 1))]
            .sort((a, b) => a.createdAt > b.createdAt ? -1 : 1);

        const periodInMinutes = this.getVariable<number>("periodinminutes", 1);
        const numberOfItems = this.getVariable<number>("numberofitems", 10);

        for (const item of sortedHistory) {
            const itemsInPeriod = sortedHistory.filter(otherItem => otherItem.createdAt < item.createdAt && otherItem.createdAt > subMinutes(item.createdAt, periodInMinutes));
            if (itemsInPeriod.length >= numberOfItems) {
                this.hitReason = `User has ${itemsInPeriod.length} items in a ${periodInMinutes} minute period up to ${item.id}`;
                return true;
            }
        }

        return false;
    }
}
