import { JobContext, JSONObject, JSONValue, ScheduledJobEvent, TriggerContext } from "@devvit/public-api";
import { ALL_EVALUATORS, ValidationIssue, yamlToVariables } from "@fsvreddit/bot-bouncer-evaluation";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import _ from "lodash";
import { sendMessageToWebhook } from "../utility.js";
import { MarkdownEntry, tsMarkdown } from "ts-markdown";
import { getControlSubSettings } from "../settings.js";
import { EvaluateBotGroupAdvanced } from "@fsvreddit/bot-bouncer-evaluation/dist/userEvaluation/EvaluateBotGroupAdvanced.js";
import { getUserExtended } from "../extendedDevvit.js";
import { addSeconds } from "date-fns";

const EVALUATOR_VARIABLES_KEY = "evaluatorVariablesHash";
const EVALUATOR_VARIABLES_YAML_PAGE_ROOT = "evaluator-config";
const EVALUATOR_VARIABLES_WIKI_PAGE = "evaluatorvars";
const EVALUATOR_VARIABLES_LAST_REVISIONS_KEY = "evaluatorVariablesLastRevisions";

export async function getEvaluatorVariables (context: TriggerContext | JobContext): Promise<Record<string, JSONValue>> {
    let allVariables: Record<string, string>;

    if (context.subredditName === CONTROL_SUBREDDIT) {
        allVariables = await context.redis.global.hGetAll(EVALUATOR_VARIABLES_KEY);
    } else {
        allVariables = await context.redis.hGetAll(EVALUATOR_VARIABLES_KEY);

        if (Object.keys(allVariables).length === 0) {
            allVariables = await context.redis.global.hGetAll(EVALUATOR_VARIABLES_KEY);
            await context.redis.hSet(EVALUATOR_VARIABLES_KEY, allVariables);
            await context.redis.expire(EVALUATOR_VARIABLES_KEY, 300); // 5 minutes
            console.log(`Evaluator Variables: Refreshed ${Object.keys(allVariables).length} evaluator variables to subreddit ${context.subredditName} from global store.`);
        }
    }

    return _.fromPairs(Object.entries(allVariables).map(([key, value]) => [key, JSON.parse(value)]));
}

export async function forceEvaluatorVariablesRefresh (context: TriggerContext | JobContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        throw new Error("Evaluator Variables: forceEvaluatorVariablesRefresh must not be called in the control subreddit.");
    }

    await context.redis.del(EVALUATOR_VARIABLES_KEY);
}

export async function getEvaluatorVariable<T> (variableName: string, context: TriggerContext | JobContext): Promise<T | undefined> {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Evaluator Variables: getEvaluatorVariable should only be called in the control subreddit.");
    }

    const variable = await context.redis.global.hGet(EVALUATOR_VARIABLES_KEY, variableName);
    if (!variable) {
        console.warn(`Evaluator Variables: Variable ${variableName} not found.`);
        return;
    }

    return JSON.parse(variable) as T;
}

export async function updateEvaluatorVariablesFromWikiHandler (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("Evaluator Variables: This job should only be run in the control subreddit.");
    }

    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.evaluatorVariableUpdatesEnabled) {
        console.log("Evaluator Variables: Evaluator variable updates from wiki are disabled in control sub settings.");
        return;
    }

    const pageList = await context.reddit.getWikiPages(CONTROL_SUBREDDIT)
        .then(pages => pages.filter(page => page === EVALUATOR_VARIABLES_YAML_PAGE_ROOT || page.startsWith(`${EVALUATOR_VARIABLES_YAML_PAGE_ROOT}/`)));

    const pages = await Promise.all(pageList.map(page => context.reddit.getWikiPage(CONTROL_SUBREDDIT, page)));

    const recentRevisions = await context.redis.hGetAll(EVALUATOR_VARIABLES_LAST_REVISIONS_KEY);
    if (!pages.some(page => recentRevisions[page.name] !== page.revisionId)) {
        console.log("Evaluator Variables: No changes detected in evaluator variable wiki pages.");
        return;
    }

    const yamlStr = pages.map(page => page.content).join("\n\n---\n\n");

    const variables = yamlToVariables(yamlStr);

    const invalidEntries = invalidEvaluatorVariableCondition(variables);
    const errors = variables.errors as string[] | undefined;
    if (errors && errors.length > 0) {
        invalidEntries.push({ severity: "error", message: errors.join(", ") });
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
                const reasons: string[] = [];
                for (const reason of evaluator.hitReasons ?? []) {
                    if (typeof reason === "string") {
                        reasons.push(reason);
                    } else {
                        reasons.push(reason.reason);
                    }
                }
                if (reasons.length === 0) {
                    reasons.push("unknown reason");
                }
                matchedMods[moderator] = reasons.join(", ");
            }
        }
        for (const [username, reason] of Object.entries(matchedMods)) {
            invalidEntries.push({ severity: "error", message: `Bot Group Advanced matched moderator ${username} with reason(s): ${JSON.stringify(reason)}` });
            console.log(`Evaluator Variables: Bot Group Advanced matched moderator ${username} with reason(s): ${JSON.stringify(reason)}`);
        }
    }

    const failedEvaluatorVariablesKey = "failedEvaluatorVariables";
    if (invalidEntries.length > 0) {
        await context.redis.set(failedEvaluatorVariablesKey, "true");
        if (!event.data?.username) {
            console.error("Evaluator Variables: Evaluator variables contains issues. Will fall back to cached values.");
            return;
        } else {
            console.error("Evaluator Variables: Invalid entries in evaluator variables", invalidEntries);

            const body: MarkdownEntry[] = [
                { p: "There are invalid regexes in the evaluator variables. Please check the wiki page and try again." },
                { ul: invalidEntries.map(entry => `${entry.severity}: ${entry.message}`) },
            ];

            let messageBody = tsMarkdown(body);
            if (messageBody.length > 10000) {
                messageBody = messageBody.substring(0, 9997) + "...";
            }

            const username = event.data.username as string;
            const controlSubSettings = await getControlSubSettings(context);
            if (controlSubSettings.monitoringWebhook) {
                const discordMessage: MarkdownEntry[] = [{ p: `${username} has updated the evaluator config, but there's an error! Please check and correct as soon as possible.` }];
                discordMessage.push({ ul: invalidEntries.map(entry => `${entry.severity}: ${entry.message}`) });
                discordMessage.push({ p: "Last known good values will be used until the issue is resolved." });
                console.log(JSON.stringify(discordMessage));
                await sendMessageToWebhook(controlSubSettings.monitoringWebhook, tsMarkdown(discordMessage));
            }

            try {
                await context.reddit.sendPrivateMessage({
                    subject: "Problem with evaluator variables config after edit",
                    to: username,
                    text: messageBody,
                });
            } catch (error) {
                console.error(`Evaluator Variables: Failed to send PM to ${username} about invalid evaluator variables.`, error);
            }

            return;
        }
    }

    for (const module of _.uniq(Object.keys(variables).map(key => key.split(":")[0]))) {
        if (module === "generic" || module === "substitutions" || module === "errors") {
            continue;
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (variables[`${module}:killswitch`] === undefined) {
            console.warn(`Evaluator Variables: Missing killswitch for module ${module}.`);
        }
    }

    const converted = _.fromPairs(Object.entries(variables).map(([key, value]) => [key, JSON.stringify(value)]));

    const existingVariables = await context.redis.global.hGetAll(EVALUATOR_VARIABLES_KEY);
    const keysToRemove = Object.keys(existingVariables).filter(key => !(key in converted));

    await context.redis.global.hSet(EVALUATOR_VARIABLES_KEY, converted);
    if (keysToRemove.length > 0) {
        await context.redis.global.hDel(EVALUATOR_VARIABLES_KEY, keysToRemove);
    }

    const newRevisions = _.fromPairs(pages.map(page => [page.name, page.revisionId]));
    await context.redis.hSet(EVALUATOR_VARIABLES_LAST_REVISIONS_KEY, newRevisions);

    const variablesCount = Object.keys(converted).length;
    console.log(`Evaluator Variables: Updated ${variablesCount} variables and removed ${keysToRemove.length} from wiki edit by /u/${event.data?.username as string | undefined ?? "unknown"}.`);

    // Write back to parsed wiki page for older client subreddits and observer subreddits
    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: EVALUATOR_VARIABLES_WIKI_PAGE,
        content: JSON.stringify(variables),
        reason: `Updating evaluator variables from wiki on /r/${context.subredditName}`,
    });

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

    await context.scheduler.runJob({
        name: ControlSubredditJob.EvaluatorReDoSChecker,
        runAt: addSeconds(new Date(), 5),
        data: { firstRun: true, modName: event.data?.username ?? "unknown" },
    });

    const previouslyFailed = await context.redis.exists(failedEvaluatorVariablesKey);
    await context.redis.del(failedEvaluatorVariablesKey);
    if (previouslyFailed && controlSubSettings.monitoringWebhook) {
        const username = event.data?.username as string | undefined ?? "unknown";
        await sendMessageToWebhook(controlSubSettings.monitoringWebhook, `✅ Successfully updated evaluator variables from wiki edit by /u/${username}.`);
    }
}

export function invalidEvaluatorVariableCondition (variables: Record<string, JSONValue>): ValidationIssue[] {
    const results: ValidationIssue[] = [];

    // Now check for inconsistent types.
    for (const key of Object.keys(variables)) {
        const value = variables[key];
        if (Array.isArray(value)) {
            const distinctTypes = _.uniq(value.map(item => typeof item));
            if (distinctTypes.length > 1) {
                results.push({ severity: "error", message: `Inconsistent types for ${key} which may be a result of an undoubled single quote: ${distinctTypes.join(", ")}` });
            }
        }
    }

    // Now check evaluator-specific validators
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator({} as unknown as TriggerContext, undefined, variables);
        const errors = evaluator.validateVariables();
        if (errors.length > 0) {
            results.push(...errors.map(r => ({ severity: r.severity, message: `${evaluator.name}: ${r.message.length < 200 ? r.message : r.message.substring(0, 197) + "..."}` })));
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (variables[`${evaluator.shortname}:killswitch`] === undefined) {
            console.warn(`Missing killswitch for ${evaluator.name}`);
        }
    }

    return results;
}
