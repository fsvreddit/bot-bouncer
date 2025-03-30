import { JobContext, JSONObject, JSONValue, ScheduledJobEvent, TriggerContext, WikiPage } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "../constants.js";

const EVALUATOR_VARIABLES_KEY = "evaluatorVariables";
const EVALUATOR_VARIABLES_WIKI_PAGE = "evaluatorvariables";
const EVALUATOR_VARIABLES_LAST_REVISION_KEY = "evaluatorVariablesLastRevision";

export async function getEvaluatorVariables (context: TriggerContext | JobContext): Promise<Record<string, JSONValue>> {
    const allVariables = await context.redis.get(EVALUATOR_VARIABLES_KEY);
    if (!allVariables) {
        return {};
    }

    const variables = JSON.parse(allVariables) as Record<string, JSONValue>;
    return variables;
}

export async function updateEvaluatorVariablesFromWikiHandler (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, EVALUATOR_VARIABLES_WIKI_PAGE);
    } catch (e) {
        console.error("Evaluator Variables: Error reading evaluator variables from wiki", e);
        return;
    }

    const lastRevision = await context.redis.get(EVALUATOR_VARIABLES_LAST_REVISION_KEY);
    if (lastRevision === wikiPage.revisionId) {
        return;
    }

    let variables: Record<string, JSONValue>;
    try {
        variables = JSON.parse(wikiPage.content) as Record<string, JSONValue>;
    } catch (error) {
        if (context.subredditName !== CONTROL_SUBREDDIT || !event.data?.username) {
            console.error("Evaluator Variables: Error parsing evaluator variables from wiki. Will fall back to cached values.");
            return;
        } else {
            console.error("Evaluator Variables: Error parsing evaluator variables from wiki", error);

            let errorMessage = `There was an error parsing the evaluator variables from the wiki. Please check the wiki page and try again.`;
            errorMessage += `\n\nError: ${error}`;

            await context.reddit.sendPrivateMessage({
                subject: "Error parsing evaluator variables",
                to: event.data.username as string,
                text: errorMessage,
            });

            return;
        }
    }

    const invalidRegexes = invalidEvaluatorVariablesRegexes(variables);
    if (invalidRegexes.length > 0) {
        if (context.subredditName !== CONTROL_SUBREDDIT || !event.data?.username) {
            console.error("Evaluator Variables: Evaluator variables contain invalid regexes. Will fall back to cached values.");
            return;
        } else {
            console.error("Evaluator Variables: Invalid regexes in evaluator variables", invalidRegexes);

            let errorMessage = `There are invalid regexes in the evaluator variables. Please check the wiki page and try again.`;
            errorMessage += `\n\nInvalid regexes:\n\n* ${invalidRegexes.join("\n* ")}`;

            await context.reddit.sendPrivateMessage({
                subject: "Invalid regexes in evaluator variables",
                to: event.data.username as string,
                text: errorMessage,
            });

            return;
        }
    }

    await context.redis.set(EVALUATOR_VARIABLES_KEY, wikiPage.content);
    await context.redis.set(EVALUATOR_VARIABLES_LAST_REVISION_KEY, wikiPage.revisionId);

    console.log("Evaluator Variables: Updated from wiki");
}

interface InvalidRegex {
    key: string;
    regex: string;
}

function isValidRegex (regex: string): boolean {
    try {
        new RegExp(regex);
        return true;
    } catch {
        return false;
    }
}

function invalidEvaluatorVariablesRegexes (variables: Record<string, JSONValue>): string[] {
    const stringVariablesWithRegexes = [
        "short-nontlc:regex",
        "short-nontlc:usernameregex",
    ];

    const arrayVariablesWithRegexes = [
        "badusername:regexes",
        "biotext:bantext",
        "pinnedpost:bantext",
        "pinnedpost:reporttext",
        "posttitle:bantext",
        "posttitle:reporttext",
        "short-tlc:botregexes",
        "zombiensfw:regexes",
    ];

    const invalidRegexes: InvalidRegex[] = [];
    for (const key of stringVariablesWithRegexes) {
        const value = variables[key] as string;
        if (!isValidRegex(value)) {
            invalidRegexes.push({ key, regex: value });
        }
    }

    for (const key of arrayVariablesWithRegexes) {
        const value = variables[key] as string[];
        for (const regex of value) {
            if (!isValidRegex(regex)) {
                invalidRegexes.push({ key, regex });
            }
        }
    }
    return invalidRegexes.map(({ key, regex }) => `${key}: \`${regex}\``);
}
