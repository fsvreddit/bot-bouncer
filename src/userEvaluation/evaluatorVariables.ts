import { JobContext, JSONObject, JSONValue, ScheduledJobEvent, TriggerContext, WikiPage } from "@devvit/public-api";
import { ALL_EVALUATORS, yamlToVariables } from "@fsvreddit/bot-bouncer-evaluation";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import { uniq } from "lodash";
import { sendMessageToWebhook } from "../utility.js";
import json2md from "json2md";
import { getControlSubSettings } from "../settings.js";
import { EvaluateBotGroupAdvanced } from "@fsvreddit/bot-bouncer-evaluation/dist/userEvaluation/EvaluateBotGroupAdvanced.js";
import { getUserExtended } from "../extendedDevvit.js";
import { addSeconds } from "date-fns";

const EVALUATOR_VARIABLES_KEY = "evaluatorVariables";
const EVALUATOR_VARIABLES_YAML_PAGE = "evaluator-config";
const EVALUATOR_VARIABLES_WIKI_PAGE = "evaluatorvars";
const EVALUATOR_VARIABLES_LAST_REVISION_KEY = "evaluatorVariablesLastRevision";

export async function getEvaluatorVariables (context: TriggerContext | JobContext): Promise<Record<string, JSONValue>> {
    const allVariables = await context.redis.get(EVALUATOR_VARIABLES_KEY);
    if (!allVariables) {
        console.warn("Evaluator Variables: No variables found in Redis, returning empty object.");
        return {};
    }

    const variables = JSON.parse(allVariables) as Record<string, JSONValue>;
    return variables;
}

async function updateEvaluatorVariablesClientSub (context: JobContext) {
    let wikiPage: WikiPage;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, EVALUATOR_VARIABLES_WIKI_PAGE);
    } catch (error) {
        console.error("Error fetching wiki page:", error);
        return;
    }

    await context.redis.set(EVALUATOR_VARIABLES_KEY, wikiPage.content);
    console.log("Evaluator Variables: Updated from wiki for client subreddit");
}

export async function updateEvaluatorVariablesFromWikiHandler (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        await updateEvaluatorVariablesClientSub(context);
        return;
    }

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, EVALUATOR_VARIABLES_YAML_PAGE);
    } catch (e) {
        console.error("Evaluator Variables: Error reading evaluator variables from wiki", e);
        return;
    }

    const lastRevision = await context.redis.get(EVALUATOR_VARIABLES_LAST_REVISION_KEY);
    if (lastRevision === wikiPage.revisionId || event.data?.username === context.appName) {
        return;
    }

    const variables = yamlToVariables(wikiPage.content);

    const invalidEntries = invalidEvaluatorVariableCondition(variables);
    const errors = variables.errors as string[] | undefined;
    if (errors && errors.length > 0) {
        invalidEntries.push(...errors);
    }

    if (invalidEntries.length === 0) {
        // Do a sanity check to ensure that nobody's done anything silly with Bot Group Advanced.
        const matchedMods: Record<string, string> = {};
        for (const moderator of ["fsv", "Leonichol", "NeedAGoodUsername"]) {
            const evaluator = new EvaluateBotGroupAdvanced(context, undefined, variables);
            const user = await getUserExtended(moderator, context);
            if (!user) {
                console.warn(`Evaluator Variables: User ${moderator} not found, skipping.`);
                continue;
            }
            const userHistory = await context.reddit.getCommentsAndPostsByUser({
                username: moderator,
                sort: "new",
                limit: 100,
            }).all();
            if (await evaluator.evaluate(user, userHistory)) {
                matchedMods[moderator] = evaluator.hitReasons?.join(", ") ?? "unknown reason";
            }
        }
        for (const [username, reason] of Object.entries(matchedMods)) {
            invalidEntries.push(`Bot Group Advanced matched moderator ${username} with reason(s): ${JSON.stringify(reason)}`);
            console.log(`Evaluator Variables: Bot Group Advanced matched moderator ${username} with reason(s): ${JSON.stringify(reason)}`);
        }
    }

    if (invalidEntries.length > 0) {
        if (!event.data?.username) {
            console.error("Evaluator Variables: Evaluator variables contains issues. Will fall back to cached values.");
            return;
        } else {
            console.error("Evaluator Variables: Invalid entries in evaluator variables", invalidEntries);

            const body: json2md.DataObject[] = [
                { p: "There are invalid regexes in the evaluator variables. Please check the wiki page and try again." },
                { ul: invalidEntries },
            ];

            let messageBody = json2md(body);
            if (messageBody.length > 10000) {
                messageBody = messageBody.substring(0, 9997) + "...";
            }

            const username = event.data.username as string;
            const controlSubSettings = await getControlSubSettings(context);
            if (controlSubSettings.monitoringWebhook) {
                const discordMessage: json2md.DataObject[] = [{ p: `${username} has updated the evaluator config, but there's an error! Please check and correct as soon as possible.` }];
                discordMessage.push({ ul: invalidEntries });
                discordMessage.push({ p: "Last known good values will be used until the issue is resolved." });
                console.log(JSON.stringify(discordMessage));
                await sendMessageToWebhook(controlSubSettings.monitoringWebhook, json2md(discordMessage));
            }

            await context.reddit.sendPrivateMessage({
                subject: "Problem with evaluator variables config after edit",
                to: username,
                text: messageBody,
            });

            return;
        }
    }

    for (const module of uniq(Object.keys(variables).map(key => key.split(":")[0]))) {
        if (module === "generic" || module === "substitutions" || module === "errors") {
            continue;
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (variables[`${module}:killswitch`] === undefined) {
            console.warn(`Evaluator Variables: Missing killswitch for module ${module}.`);
        }
    }

    await context.redis.set(EVALUATOR_VARIABLES_KEY, JSON.stringify(variables));
    await context.redis.set(EVALUATOR_VARIABLES_LAST_REVISION_KEY, wikiPage.revisionId);

    console.log("Evaluator Variables: Updated from wiki");

    // Write back to parsed wiki page for client subreddits and observer subreddits
    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: EVALUATOR_VARIABLES_WIKI_PAGE,
        content: JSON.stringify(variables),
        reason: `Updating evaluator variables from wiki on /r/${context.subredditName}`,
    });

    const controlSubSettings = await getControlSubSettings(context);
    if (controlSubSettings.observerSubreddits?.length) {
        for (const subreddit of controlSubSettings.observerSubreddits) {
            await context.reddit.updateWikiPage({
                subredditName: subreddit,
                page: EVALUATOR_VARIABLES_WIKI_PAGE,
                content: JSON.stringify(variables),
            });
            console.log(`Evaluator Variables: Updated wiki page on /r/${subreddit}`);
        }
    }

    await context.scheduler.runJob({
        name: ControlSubredditJob.ConditionalStatsUpdate,
        runAt: addSeconds(new Date(), 10),
    });
}

export function invalidEvaluatorVariableCondition (variables: Record<string, JSONValue>): string[] {
    const results: string[] = [];

    // Now check for inconsistent types.
    for (const key of Object.keys(variables)) {
        const value = variables[key];
        if (Array.isArray(value)) {
            const distinctTypes = uniq(value.map(item => typeof item));
            if (distinctTypes.length > 1) {
                results.push(`Inconsistent types for ${key} which may be a result of an undoubled single quote: ${distinctTypes.join(", ")}`);
            }
        }
    }

    // Now check evaluator-specific validators
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator({} as unknown as TriggerContext, undefined, variables);
        const errors = evaluator.validateVariables();
        if (errors.length > 0) {
            results.push(...errors.map(r => `${evaluator.name}: ${r.length < 200 ? r : r.substring(0, 197) + "..."}`));
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (variables[`${evaluator.shortname}:killswitch`] === undefined) {
            console.warn(`Missing killswitch for ${evaluator.name}`);
        }
    }

    return results;
}
