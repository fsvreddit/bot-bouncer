import { redis, scheduler, TaskRequest } from "@devvit/web/server";
import { updateBioStatistics, updateDisplayNameStatistics, updateSocialLinksStatistics, updateUsernameStatistics } from ".";
import { getEvaluatorVariables } from "../../userEvaluation";
import { FLAGS_TO_EXCLUDE_FROM_STATS, StatsUserEntry } from "./statsHelpers";
import { hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addDays, addMinutes, addSeconds, subMonths } from "date-fns";
import { ALL_POTENTIAL_USER_PREFIXES, ControlSubredditJob, getFullDataStore } from "../..";
import { JsonValue } from "@devvit/web/shared";
import { ConditionalStatsUpdateJobData, DefinedHandlesStatsInitializerJobData } from "../../../tasks";
import _ from "lodash";

interface ConditionalStatsUpdateConfig {
    statName: string;
    variableKeys: string[];
    lookbackMonths: number;
    updateFunction: (allEntries: StatsUserEntry[]) => Promise<void>;
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

export async function conditionalStatsUpdate (event: TaskRequest<ConditionalStatsUpdateJobData | undefined>) {
    const jobGuid = event.data?.jobGuid;
    if (jobGuid && await hasTriggerBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Conditional Stats Update: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const evaluatorVariables = await getEvaluatorVariables();

    const configsToUpdate = _.compact(await Promise.all(STATUS_UPDATE_CONFIGS.map(async (config) => {
        const shouldUpdate = await shouldUpdateStatistic(config, evaluatorVariables);
        return shouldUpdate ? config : undefined;
    })));

    if (configsToUpdate.length === 0) {
        console.log("Conditional Stats Update: No statistics require updating.");
        return;
    }

    console.log(`Conditional Stats Update: Preparing to update statistics for ${configsToUpdate.map(c => c.statName).join(", ")}.`);

    const allData = await getFullDataStore({
        since: subMonths(new Date(), Math.max(...configsToUpdate.map(c => c.lookbackMonths))),
        omitFlags: FLAGS_TO_EXCLUDE_FROM_STATS,
    });

    console.log(`Conditional Stats Update: Retrieved ${Object.keys(allData).length} user entries from the data store.`);

    const allEntries = Object.entries(allData)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        .map(([key, value]) => ({ username: key, data: value } as StatsUserEntry));

    const promises: Promise<unknown>[] = [];
    for (const config of configsToUpdate) {
        promises.push(config.updateFunction(allEntries));
        console.log(`Conditional Stats Update: Updating ${config.statName} statistics.`);
    }

    await Promise.all(promises);
}

export async function shouldUpdateStatistic (config: ConditionalStatsUpdateConfig, variables: Record<string, JsonValue>): Promise<boolean> {
    const redisKey = `${config.statName}ConfigCachedValue`;
    const currentConfig: Record<string, unknown> = {};

    for (const key of config.variableKeys) {
        currentConfig[key] = variables[key];
    }

    const cachedEntries = await redis.get(redisKey);
    if (cachedEntries === JSON.stringify(currentConfig)) {
        return false;
    }

    await redis.set(redisKey, JSON.stringify(currentConfig), { expiration: addDays(new Date(), 7) });
    return true;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function definedHandlesStatsJobRunner (_: StatsUserEntry[]) {
    await scheduler.runJob<DefinedHandlesStatsInitializerJobData>({
        name: ControlSubredditJob.DefinedHandlesStatisticsInitialiser,
        runAt: addSeconds(new Date(), 5),
        data: {
            firstRun: true,
            prefixes: ALL_POTENTIAL_USER_PREFIXES,
            jobGuid: crypto.randomUUID(),
        },
    });
};
