import { redis, scheduler, TaskRequest } from "@devvit/web/server";
import { socialLinksStatisticsJobRunner, updateBioStatistics, updateDisplayNameStatistics, updateUsernameStatistics } from ".";
import { getEvaluatorVariables } from "../../userEvaluation";
import { FLAGS_TO_EXCLUDE_FROM_STATS, StatsUserEntry } from "./statsHelpers";
import { expireKeyAt, hasEventBeenHandled, hGetAllChunked } from "@fsvreddit/fsv-devvit-web-helpers";
import { addDays, addMinutes, addSeconds, subMonths } from "date-fns";
import { ALL_POTENTIAL_USER_PREFIXES, ControlSubredditJob, getDataStoreFiltered, hSetChunked, sha256hash, UserDetails } from "../..";
import { JsonValue } from "@devvit/web/shared";
import { ConditionalStatsUpdateJobData, DefinedHandlesStatsInitializerJobData } from "../../../tasks";
import { compact, fromPairs } from "lodash-es";

export enum StatisticsName {
    BadUsernames = "badUsernames",
    DisplayNames = "displayNames",
    SocialLinks = "socialLinks",
    BioText = "bioText",
    DefinedHandles = "definedHandles",
}

interface ConditionalStatsUpdateConfig {
    statName: StatisticsName;
    variableKeys: string[];
    lookbackMonths: number;
    updateFunction: (allEntries: StatsUserEntry[]) => Promise<void>;
}

const STATUS_UPDATE_CONFIGS: ConditionalStatsUpdateConfig[] = [
    {
        statName: StatisticsName.BadUsernames,
        variableKeys: ["badusername:regexes"],
        lookbackMonths: 1,
        updateFunction: updateUsernameStatistics,
    },
    {
        statName: StatisticsName.DisplayNames,
        variableKeys: ["baddisplayname:regexes"],
        lookbackMonths: 1,
        updateFunction: updateDisplayNameStatistics,
    },
    {
        statName: StatisticsName.SocialLinks,
        variableKeys: ["sociallinks:badlinks", "sociallinks:ignored"],
        lookbackMonths: 0,
        updateFunction: socialLinksStatisticsJobRunner,
    },
    {
        statName: StatisticsName.BioText,
        variableKeys: ["biotext:bantext", "biotext:entriesToAllowlist", "substitutions:definedhandles"],
        lookbackMonths: 1,
        updateFunction: updateBioStatistics,
    },
    {
        statName: StatisticsName.DefinedHandles,
        variableKeys: ["substitutions:definedhandles"],
        lookbackMonths: 0,
        updateFunction: definedHandlesStatsJobRunner,
    },
];

export async function conditionalStatsUpdate (event: TaskRequest<ConditionalStatsUpdateJobData>) {
    const jobGuid = event.data.jobGuid;
    if (await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Conditional Stats Update: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    if (event.data.phase === "initial") {
        const evaluatorVariables = await getEvaluatorVariables();

        const configsToUpdate = compact(await Promise.all(STATUS_UPDATE_CONFIGS.map(async (config) => {
            const shouldUpdate = await shouldUpdateStatistic(config, evaluatorVariables);
            return shouldUpdate ? config : undefined;
        })));

        if (configsToUpdate.length === 0) {
            console.log("Conditional Stats Update: No statistics require updating.");
            return;
        }

        console.log(`Conditional Stats Update: Preparing to update statistics for ${configsToUpdate.map(c => c.statName).join(", ")}.`);

        const lookBackMonths = Math.max(...configsToUpdate.map(c => c.lookbackMonths));
        if (lookBackMonths > 0) {
            await scheduler.runJob<ConditionalStatsUpdateJobData>({
                name: ControlSubredditJob.ConditionalStatsUpdate,
                runAt: new Date(),
                data: {
                    jobGuid: crypto.randomUUID(),
                    phase: "gather",
                    lookBackMonths,
                    prefixes: ALL_POTENTIAL_USER_PREFIXES,
                    statsNames: configsToUpdate.map(c => c.statName),
                },
            });
        } else {
            await scheduler.runJob<ConditionalStatsUpdateJobData>({
                name: ControlSubredditJob.ConditionalStatsUpdate,
                runAt: new Date(),
                data: {
                    jobGuid: crypto.randomUUID(),
                    phase: "process",
                    statsNames: configsToUpdate.map(c => c.statName),
                    lookBackMonths,
                },
            });
        }

        return;
    }

    const allDataKey = "ConditionalStatsData";

    if (event.data.phase === "gather") {
        if (!event.data.prefixes) {
            throw new Error("Conditional Stats Update: Missing prefixes for gather phase.");
        }

        if (!event.data.lookBackMonths) {
            throw new Error("Conditional Stats Update: Missing lookBackMonths for gather phase.");
        }

        if (event.data.prefixes.length === ALL_POTENTIAL_USER_PREFIXES.length) {
            await redis.del(allDataKey);
        }

        const runLimit = addSeconds(new Date(), 10);
        let prefixesProcessed = 0;

        while (event.data.prefixes.length > 0 && new Date() < runLimit) {
            const prefix = event.data.prefixes.shift();
            if (!prefix) {
                break;
            }

            const dataForPrefix = await getDataStoreFiltered(prefix, {
                since: subMonths(new Date(), event.data.lookBackMonths),
                omitFlags: FLAGS_TO_EXCLUDE_FROM_STATS,
            });

            const dataToStore = Object.entries(dataForPrefix).map(([key, value]) => ([key, JSON.stringify(value)]));
            await hSetChunked(redis, allDataKey, fromPairs(dataToStore));
            await expireKeyAt(allDataKey, addMinutes(new Date(), 10));
            prefixesProcessed++;
        }

        console.log(`Conditional Stats Update: Processed ${prefixesProcessed} prefixes, ${event.data.prefixes.length} remaining.`);

        if (event.data.prefixes.length > 0) {
            await scheduler.runJob<ConditionalStatsUpdateJobData>({
                name: ControlSubredditJob.ConditionalStatsUpdate,
                runAt: new Date(),
                data: {
                    jobGuid: crypto.randomUUID(),
                    phase: "gather",
                    prefixes: event.data.prefixes,
                    lookBackMonths: event.data.lookBackMonths,
                    statsNames: event.data.statsNames,
                },
            });
        } else {
            await scheduler.runJob<ConditionalStatsUpdateJobData>({
                name: ControlSubredditJob.ConditionalStatsUpdate,
                runAt: new Date(),
                data: {
                    jobGuid: crypto.randomUUID(),
                    phase: "process",
                    lookBackMonths: event.data.lookBackMonths,
                    statsNames: event.data.statsNames,
                },
            });
        }

        return;
    }

    const statsNames = event.data.statsNames;
    if (statsNames === undefined) {
        throw new Error("Missing statsNames in event data.");
    }

    const lookBackMonths = event.data.lookBackMonths;
    if (lookBackMonths === undefined) {
        throw new Error("Missing lookBackMonths in event data.");
    }

    const configsToUpdate = STATUS_UPDATE_CONFIGS.filter(config => statsNames.includes(config.statName));

    const allData = await hGetAllChunked(allDataKey);
    await redis.del(allDataKey);

    console.log(`Conditional Stats Update: Preparing to update statistics for ${configsToUpdate.map(c => c.statName).join(", ")}.`);

    const allEntries = Object.entries(allData)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        .map(([key, value]) => ({ username: key, data: JSON.parse(value) as UserDetails } as StatsUserEntry));

    if (allEntries.length === 0 && lookBackMonths > 0) {
        console.log("Conditional Stats Update: No user entries available for updating statistics.");
        return;
    }

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

    const currentConfigHash = sha256hash(JSON.stringify(currentConfig));

    const cachedEntries = await redis.get(redisKey);
    if (cachedEntries === currentConfigHash) {
        return false;
    }

    await redis.set(redisKey, currentConfigHash, { expiration: addDays(new Date(), 7) });
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
