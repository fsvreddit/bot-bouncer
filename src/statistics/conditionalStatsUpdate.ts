import { JobContext, JSONValue } from "@devvit/public-api";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";
import { updateSocialLinksStatistics } from "./socialLinksStatistics.js";
import { updateBioStatistics } from "./userBioStatistics.js";
import { FLAGS_TO_EXCLUDE_FROM_STATS, StatsUserEntry } from "../scheduler/sixHourlyJobs.js";
import { addDays, subMonths } from "date-fns";
import { updateUsernameStatistics } from "./usernameStatistics.js";
import { updateDisplayNameStatistics } from "./displayNameStats.js";
import { updateDefinedHandlesStats } from "./definedHandlesStatistics.js";
import { getFullDataStore } from "../dataStore.js";

interface ConditionalStatsUpdateConfig {
    statName: string;
    variableKeys: string[];
    updateFunction: (allEntries: StatsUserEntry[], context: JobContext) => Promise<void>;
}

const STATUS_UPDATE_CONFIGS: ConditionalStatsUpdateConfig[] = [
    {
        statName: "badUsernames",
        variableKeys: ["badusername:regexes"],
        updateFunction: updateUsernameStatistics,
    },
    {
        statName: "displayNames",
        variableKeys: ["baddisplayname:regexes"],
        updateFunction: updateDisplayNameStatistics,
    },
    {
        statName: "socialLinks",
        variableKeys: ["sociallinks:badlinks", "sociallinks:ignored"],
        updateFunction: updateSocialLinksStatistics,
    },
    {
        statName: "bioText",
        variableKeys: ["biotext:bantext"],
        updateFunction: updateBioStatistics,
    },
    {
        statName: "definedHandles",
        variableKeys: ["substitutions:definedhandles"],
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

    const allData = await getFullDataStore(context, {
        since: subMonths(new Date(), 3),
        omitFlags: FLAGS_TO_EXCLUDE_FROM_STATS,
    });

    const allEntries = Object.entries(allData)
        .map(([key, value]) => ({ username: key, data: value } as StatsUserEntry));

    const promises: Promise<unknown>[] = [];
    for (const config of configsToUpdate) {
        promises.push(config.updateFunction(allEntries, context));
        console.log(`Conditional Stats Update: Updating ${config.statName} statistics.`);
    }

    await Promise.all(promises);
}

export async function shouldUpdateStatistic (config: ConditionalStatsUpdateConfig, variables: Record<string, JSONValue>, context: JobContext): Promise<boolean> {
    const redisKey = `${config.statName}ConfigCached`;
    const currentConfig: Record<string, unknown> = {};

    for (const key of config.variableKeys) {
        currentConfig[key] = variables[key];
    }

    const cachedEntries = await context.redis.get(redisKey);
    if (cachedEntries === JSON.stringify(currentConfig)) {
        return false;
    }

    await context.redis.set(redisKey, JSON.stringify(currentConfig), { expiration: addDays(new Date(), 7) });
    return true;
}
