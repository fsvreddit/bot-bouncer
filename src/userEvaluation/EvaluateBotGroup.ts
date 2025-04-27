import { Comment, Post } from "@devvit/public-api";
import { CommentCreate } from "@devvit/protos";
import { UserEvaluatorBase } from "./UserEvaluatorBase.js";
import { UserExtended } from "../extendedDevvit.js";
import { endOfDay, parse } from "date-fns";

interface BotGroup {
    name: string;
    usernameRegex: RegExp;
    dateFrom: Date;
    dateTo: Date;
    subreddits?: string[];
}

export class EvaluateBotGroup extends UserEvaluatorBase {
    override name = "Bot Group";
    override shortname = "botgroup";
    override banContentThreshold = 1;

    public getBotGroups (): BotGroup[] {
        const results: BotGroup[] = [];
        const variables = this.getAllVariables("group");
        const groups = Object.entries(variables).map(([key, value]) => ({ key, group: value as Record<string, unknown> }));
        for (const { key, group } of groups) {
            const name = group.name as string | undefined;
            const dateFrom = group.dateFrom as string | undefined;
            const dateTo = group.dateTo as string | undefined;
            const subreddits = group.subreddits as string[] | undefined;
            const usernameRegex = group.usernameRegex as string | undefined;

            if (!name || !dateFrom || !dateTo || !usernameRegex) {
                throw new Error(`Bot group ${key} is missing required fields. Mandatory fields are name, dateFrom, dateTo, and usernameRegex.`);
            }

            const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
            if (!dateRegex.test(dateFrom)) {
                throw new Error(`Invalid date format for dateFrom in bot group ${key}. Expected format is YYYY-MM-DD.`);
            }
            if (!dateRegex.test(dateTo)) {
                throw new Error(`Invalid date format for dateTo in bot group ${key}. Expected format is YYYY-MM-DD.`);
            }

            if (dateFrom > dateTo) {
                throw new Error(`dateFrom cannot be after dateTo in bot group ${key}.`);
            }

            try {
                new RegExp(usernameRegex);
            } catch {
                throw new Error(`Invalid regex for usernameRegex in bot group ${key}.`);
            }

            try {
                results.push({
                    name,
                    usernameRegex: new RegExp(usernameRegex),
                    dateFrom: parse(dateFrom, "yyyy-MM-dd", new Date()),
                    dateTo: endOfDay(parse(dateTo, "yyyy-MM-dd", new Date())),
                    subreddits,
                });
            } catch (error) {
                throw new Error(`Error parsing bot group ${key}: ${error}`);
            }
        }

        return results;
    }

    override validateVariables (): string[] {
        try {
            this.getBotGroups();
            return [];
        } catch (error) {
            if (error instanceof Error) {
                return [`Error parsing bot groups: ${error.message}`];
            }
            return [`Error parsing bot groups: ${error}`];
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    override preEvaluateComment (_: CommentCreate): boolean {
        return false;
    }

    override preEvaluatePost (post: Post): boolean {
        const botGroups = this.getBotGroups();
        return botGroups.some(group => group.subreddits?.some(subreddit => subreddit === post.subredditName));
    }

    override preEvaluateUser (user: UserExtended): boolean {
        const botGroups = this.getBotGroups();
        return botGroups.some(group => group.usernameRegex.test(user.username) && user.createdAt > group.dateFrom && user.createdAt < group.dateTo);
    }

    override evaluate (user: UserExtended, history: (Post | Comment)[]): boolean {
        const botGroups = this.getBotGroups();
        const matchedGroup = botGroups.find(group => group.usernameRegex.test(user.username)
            && user.createdAt > group.dateFrom
            && user.createdAt < group.dateTo
            && (!group.subreddits || history.some(item => group.subreddits?.some(subreddit => subreddit === item.subredditName))));

        if (!matchedGroup) {
            this.setReason("User does not match any bot group");
            return false;
        }

        this.hitReason = `User matches bot group ${matchedGroup.name}`;
        return true;
    }
}
