import { JobContext, JSONObject, JSONValue, ScheduledJobEvent } from "@devvit/public-api";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";
import { updateSocialLinksStatistics } from "./socialLinksStatistics.js";
import { updateBioStatistics } from "./userBioStatistics.js";
import { FLAGS_TO_EXCLUDE_FROM_STATS, StatsUserEntry } from "../scheduler/sixHourlyJobs.js";
import { addDays, addMinutes, addSeconds, subMonths } from "date-fns";
import { updateUsernameStatistics } from "./usernameStatistics.js";
import { updateDisplayNameStatistics } from "./displayNameStats.js";
import { ALL_POTENTIAL_USER_PREFIXES, getFullDataStore } from "../dataStore.js";
import _ from "lodash";
import { ControlSubredditJob } from "../constants.js";
import { DefinedHandlesStatsInitializerJobData } from "./definedHandlesStatistics.js";
import { hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-helpers";

interface ConditionalStatsUpdateConfig {
    statName: string;
    variableKeys: string[];
    lookbackMonths: number;
    updateFunction: (allEntries: StatsUserEntry[], context: JobContext) => Promise<void>;
}

const STATUS_UPDATE_CONFIGS: ConditionalStatsUpdateConfig[] = [
    {
        statName: "badUsernames",
        variableKeys: ["badusername:regexes"],
        lookbackMonths: 1,
        updateFunction: updateUsernameStatistics,
    },
    {
        statName: "displayNames",
        variableKeys: ["baddisplayname:regexes"],
        lookbackMonths: 1,
        updateFunction: updateDisplayNameStatistics,
    },
    {
        statName: "socialLinks",
        variableKeys: ["sociallinks:badlinks", "sociallinks:ignored"],
        lookbackMonths: 3,
        updateFunction: updateSocialLinksStatistics,
    },
    {
        statName: "bioText",
        variableKeys: ["biotext:bantext"],
        lookbackMonths: 1,
        updateFunction: updateBioStatistics,
    },
    {
        statName: "definedHandles",
        variableKeys: ["substitutions:definedhandles"],
        lookbackMonths: 0,
        updateFunction: definedHandlesStatsJobRunner,
    },
];

export async function conditionalStatsUpdate (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const jobGuid = event.data?.jobGuid as string | undefined;
    if (jobGuid && await hasTriggerBeenHandled(context.redis, `job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Conditional Stats Update: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const evaluatorVariables = await getEvaluatorVariables(context);

    const configsToUpdate = _.compact(await Promise.all(STATUS_UPDATE_CONFIGS.map(async (config) => {
        const shouldUpdate = await shouldUpdateStatistic(config, evaluatorVariables, context);
        return shouldUpdate ? config : undefined;
    })));

    if (configsToUpdate.length === 0) {
        console.log("Conditional Stats Update: No statistics require updating.");
        return;
    }

    console.log(`Conditional Stats Update: Preparing to update statistics for ${configsToUpdate.map(c => c.statName).join(", ")}.`);

    const allData = await getFullDataStore(context, {
        since: subMonths(new Date(), Math.max(...configsToUpdate.map(c => c.lookbackMonths))),
        omitFlags: FLAGS_TO_EXCLUDE_FROM_STATS,
    });

    console.log(`Conditional Stats Update: Retrieved ${Object.keys(allData).length} user entries from the data store.`);

    const allEntries = Object.entries(allData)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        .map(([key, value]) => ({ username: key, data: value } as StatsUserEntry));

    const promises: Promise<unknown>[] = [];
    for (const config of configsToUpdate) {
        promises.push(config.updateFunction(allEntries, context));
        console.log(`Conditional Stats Update: Updating ${config.statName} statistics.`);
    }

    await Promise.all(promises);
}

export async function shouldUpdateStatistic (config: ConditionalStatsUpdateConfig, variables: Record<string, JSONValue>, context: JobContext): Promise<boolean> {
    const redisKey = `${config.statName}ConfigCachedValue`;
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

async function definedHandlesStatsJobRunner (_: StatsUserEntry[], context: JobContext) {
    await context.scheduler.runJob({
        name: ControlSubredditJob.DefinedHandlesStatisticsInitialiser,
        runAt: addSeconds(new Date(), 5),
        data: {
            firstRun: true,
            prefixes: ALL_POTENTIAL_USER_PREFIXES,
            jobGuid: crypto.randomUUID(),
        } satisfies DefinedHandlesStatsInitializerJobData,
    });
};
