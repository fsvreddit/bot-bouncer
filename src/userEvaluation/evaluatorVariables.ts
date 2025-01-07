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
        console.error("Error reading evaluator variables from wiki", e);
        return;
    }

    const lastRevision = await context.redis.get(EVALUATOR_VARIABLES_LAST_REVISION_KEY);
    if (lastRevision === wikiPage.revisionId) {
        return;
    }

    if (context.subredditName === CONTROL_SUBREDDIT && event.data?.username) {
        try {
            JSON.parse(wikiPage.content) as Record<string, JSONValue>;
        } catch (error) {
            console.error("Error parsing evaluator variables from wiki", error);

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

    await context.redis.set(EVALUATOR_VARIABLES_KEY, wikiPage.content);
    await context.redis.set(EVALUATOR_VARIABLES_LAST_REVISION_KEY, wikiPage.revisionId);

    console.log("Evaluator Variables: Updated from wiki");
}
