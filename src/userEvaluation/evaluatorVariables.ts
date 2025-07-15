import { JobContext, JSONObject, JSONValue, ScheduledJobEvent, TriggerContext, WikiPage } from "@devvit/public-api";
import { ALL_EVALUATORS } from "@fsvreddit/bot-bouncer-evaluation";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { parseAllDocuments } from "yaml";
import { uniq } from "lodash";
import { replaceAll, sendMessageToWebhook } from "../utility.js";
import json2md from "json2md";
import { getControlSubSettings } from "../settings.js";

const EVALUATOR_VARIABLES_KEY = "evaluatorVariables";
const EVALUATOR_VARIABLES_YAML_PAGE = "evaluator-config";
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

export function yamlToVariables (input: string): Record<string, JSONValue> {
    const yamlDocuments = parseAllDocuments(input);
    const variables: Record<string, JSONValue> = {};

    const modulesSeen = new Set<string>();

    const substitutions: Record<string, string> = {};

    let index = 0;
    for (const doc of yamlDocuments) {
        const json = doc.toJSON() as Record<string, JSONValue> | null;
        if (!json) {
            // Empty document
            continue;
        }

        const root = json.name as string | undefined;
        if (!root) {
            console.error(`Evaluator Variables: Error parsing evaluator variables from wiki. Missing root name on document ${index}.`);
            continue;
        }

        // Special case: if in "substitutions" module, add to substitutions map
        if (root === "substitutions") {
            for (const key in json) {
                if (key === "name") {
                    continue;
                }
                substitutions[key] = json[key] as string;
            }
        }

        if (modulesSeen.has(root)) {
            console.warn(`Evaluator Variables: Module name ${root} is present more than once. This is not permitted.`);
            modulesSeen.add(root);
        }

        for (const key in json) {
            if (key !== "name") {
                let value = json[key];
                if (typeof value === "string") {
                    for (const subKey in substitutions) {
                        value = replaceAll(value, `{{${subKey}}}`, substitutions[subKey]);
                    }
                } else if (Array.isArray(value)) {
                    value = value.map((item) => {
                        if (typeof item === "string") {
                            for (const subKey in substitutions) {
                                item = replaceAll(item, `{{${subKey}}}`, substitutions[subKey]);
                            }
                        }
                        return item;
                    });
                }

                variables[`${root}:${key}`] = value;
            }
        }

        index++;
    }

    return variables;
}

export async function updateEvaluatorVariablesFromWikiHandler (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
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
    if (invalidEntries.length > 0) {
        if (context.subredditName !== CONTROL_SUBREDDIT || !event.data?.username) {
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
                await sendMessageToWebhook(controlSubSettings.monitoringWebhook, `${username} has updated the evaluator config, but there's an error! Please check and correct as soon as possible. Falling back on known good values.`);
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
        if (module === "generic" || module === "substitutions") {
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

    if (context.subredditName === CONTROL_SUBREDDIT) {
        // Write back to older wiki page for backwards compatibility
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
    }
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
        const evaluator = new Evaluator({} as unknown as TriggerContext, variables);
        const errors = evaluator.validateVariables();
        if (errors.length > 0) {
            results.push(`Evaluator ${evaluator.shortname} has the following errors: ${errors.join(", ")}`);
        }
    }

    return results;
}
