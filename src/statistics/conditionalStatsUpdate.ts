import { JobContext, JSONValue } from "@devvit/public-api";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";
import { updateSocialLinksStatistics } from "./socialLinksStatistics.js";
import { updateBioStatistics } from "./userBioStatistics.js";
import { getAllValuesForStats, StatsUserEntry } from "../sixHourlyJobs.js";
import { addDays } from "date-fns";
import { updateUsernameStatistics } from "./usernameStatistics.js";
import { updateDisplayNameStatistics } from "./displayNameStats.js";
import { updateDefinedHandlesStats } from "./definedHandlesStatistics.js";

interface ConditionalStatsUpdateConfig {
    statName: string;
    variableKey: string;
    updateFunction: (allEntries: StatsUserEntry[], context: JobContext) => Promise<void>;
}

const STATUS_UPDATE_CONFIGS: ConditionalStatsUpdateConfig[] = [
    {
        statName: "badUsernames",
        variableKey: "badusername:regexes",
        updateFunction: updateUsernameStatistics,
    },
    {
        statName: "displayNames",
        variableKey: "baddisplayname:regexes",
        updateFunction: updateDisplayNameStatistics,
    },
    {
        statName: "socialLinks",
        variableKey: "sociallinks:badlinks",
        updateFunction: updateSocialLinksStatistics,
    },
    {
        statName: "bioText",
        variableKey: "biotext:bantext",
        updateFunction: updateBioStatistics,
    },
    {
        statName: "definedHandles",
        variableKey: "substitutions:definedhandles",
        updateFunction: updateDefinedHandlesStats,
    },
];

export async function conditionalStatsUpdate (_: unknown, context: JobContext) {
    const evaluatorVariables = await getEvaluatorVariables(context);

    const configsToUpdate: ConditionalStatsUpdateConfig[] = [];

    for (const config of STATUS_UPDATE_CONFIGS) {
        const shouldUpdate = await shouldUpdateStatistic(config, evaluatorVariables, context);
        if (shouldUpdate) {
            configsToUpdate.push(config);
        }
    }

    if (configsToUpdate.length === 0) {
        console.log("Conditional Stats Update: No statistics require updating.");
        return;
    }

    console.log(`Conditional Stats Update: Preparing to update statistics for ${configsToUpdate.map(c => c.statName).join(", ")}.`);

    const { allEntries } = await getAllValuesForStats(context);

    const promises: Promise<unknown>[] = [];
    for (const config of configsToUpdate) {
        promises.push(config.updateFunction(allEntries, context));
        console.log(`Conditional Stats Update: Updating ${config.statName} statistics.`);
    }

    await Promise.all(promises);
}

export async function shouldUpdateStatistic (config: ConditionalStatsUpdateConfig, variables: Record<string, JSONValue>, context: JobContext): Promise<boolean> {
    const redisKey = `${config.statName}ConfigCached`;
    const currentConfig = variables[config.variableKey] as string[] | undefined ?? [];

    const cachedEntries = await context.redis.get(redisKey);
    if (JSON.stringify(cachedEntries) === JSON.stringify(currentConfig)) {
        return false;
    }

    await context.redis.set(redisKey, JSON.stringify(currentConfig), { expiration: addDays(new Date(), 7) });
    return true;
}
