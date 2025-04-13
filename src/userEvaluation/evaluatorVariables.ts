import { JobContext, JSONObject, JSONValue, ScheduledJobEvent, TriggerContext, WikiPage } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "../constants.js";
import { parseAllDocuments } from "yaml";
import { uniq } from "lodash";
import { replaceAll } from "../utility.js";

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
    if (lastRevision === wikiPage.revisionId) {
        return;
    }

    const variables = yamlToVariables(wikiPage.content);

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

    // Write back to older wiki page for backwards compatibility
    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: EVALUATOR_VARIABLES_WIKI_PAGE,
        content: JSON.stringify(variables, null, 4),
    });

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
    const stringVariablesWithRegexes: string[] = [

    ];

    const arrayVariablesWithRegexes = [
        "badusername:regexes",
        "biotext:bantext",
        "pinnedpost:bantext",
        "pinnedpost:reporttext",
        "posttitle:bantext",
        "posttitle:reporttext",
        "zombiensfw:regexes",
    ];

    const invalidRegexes: InvalidRegex[] = [];
    for (const key of stringVariablesWithRegexes) {
        if (!variables[key]) {
            console.warn(`Evaluator Variables: Missing variable ${key}.`);
            continue;
        }
        const value = variables[key] as string;
        if (!isValidRegex(value)) {
            invalidRegexes.push({ key, regex: value });
        }
    }

    for (const key of arrayVariablesWithRegexes) {
        if (!variables[key]) {
            console.warn(`Evaluator Variables: Missing variable ${key}.`);
            continue;
        }
        const value = variables[key] as string[];
        for (const regex of value) {
            if (!isValidRegex(regex)) {
                invalidRegexes.push({ key, regex });
            }
        }
    }
    return invalidRegexes.map(({ key, regex }) => `${key}: \`${regex}\``);
}
