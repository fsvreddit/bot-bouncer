import { reddit, redis, scheduler, TaskRequest } from "@devvit/web/server";
import { EvaluationResult, UserStatus } from "@fsvreddit/bot-bouncer-types";
import { ALL_POTENTIAL_USER_PREFIXES, ALL_RELEVANT_EVALUTORS, CONTROL_SUBREDDIT, ControlSubredditJob, getAccountInitialEvaluationResults, getDataStoreFiltered, hGetAllChunked, normaliseHitReason } from "../..";
import { addMinutes, addSeconds, format, subDays } from "date-fns";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { FLAGS_TO_EXCLUDE_FROM_STATS } from "./statsHelpers";
import json2md from "json2md";
import { getEvaluatorVariables } from "../../userEvaluation";
import { BuildEvaluatorAccuracyStatisticsJobData, EvaluatorAccuracyInitialiserData } from "../../../tasks";
import _ from "lodash";

const ACCURACY_QUEUE = "evaluatorAccuracyQueue";
const ACCURACY_STORE = "evaluatorAccuracyStore";

interface AccuracyQueueItem {
    status: UserStatus;
    reportedAt?: number;
}

interface EvaluationAccuracyResult {
    totalCount: number;
    bannedCount: number;
    bannedAccounts: string[];
    unbannedAccounts: string[];
    lastSeen?: number;
}

function getEvaluationResultsKey (evaluationResult: EvaluationResult): string {
    if (evaluationResult.hitReason && evaluationResult.botName.includes("Bot Group")) {
        const normalisedHitReason = normaliseHitReason(evaluationResult.hitReason);
        return `${evaluationResult.botName}~${normalisedHitReason.reason}`;
    } else {
        return evaluationResult.botName;
    }
}

export async function initialiseEvaluatorAccuracyStatistics (event: TaskRequest<EvaluatorAccuracyInitialiserData | undefined>) {
    if (!event.data) {
        console.warn("Evaluator Accuracy Statistics: No data provided for initialiser job, skipping.");
        return;
    }

    if (await hasEventBeenHandled(`job:${event.data.jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Evaluator Accuracy Statistics: Initialiser job with guid ${event.data.jobGuid} has already been handled, skipping.`);
        return;
    }

    if (!event.data.prefixes) {
        await redis.del(ACCURACY_QUEUE, ACCURACY_STORE);
    }

    const prefixes = event.data.prefixes ?? [...ALL_POTENTIAL_USER_PREFIXES];

    console.log(`Evaluator Accuracy Statistics: Initialising with ${prefixes.length} prefixes.`);

    const runLimit = addSeconds(new Date(), 10);

    while (prefixes.length > 0 && new Date() < runLimit) {
        const prefix = prefixes.shift();
        if (!prefix) {
            break;
        }

        const dataForPrefix = await getDataStoreFiltered(prefix, {
            since: subDays(new Date(), 14),
            omitFlags: FLAGS_TO_EXCLUDE_FROM_STATS,
        });

        const recordsToQueue = Object.entries(dataForPrefix).map(([username, data]) => {
            let itemToQueue: AccuracyQueueItem;
            if (data.userStatus === UserStatus.Purged || data.userStatus === UserStatus.Retired) {
                itemToQueue = { status: data.lastStatus ?? data.userStatus, reportedAt: data.reportedAt };
            } else {
                itemToQueue = { status: data.userStatus, reportedAt: data.reportedAt };
            }
            return [username, JSON.stringify(itemToQueue)];
        });

        await redis.hSet(ACCURACY_QUEUE, _.fromPairs(recordsToQueue));
    }

    if (prefixes.length > 0) {
        await scheduler.runJob<EvaluatorAccuracyInitialiserData>({
            name: ControlSubredditJob.EvaluatorAccuracyStatisticsInitialiser,
            runAt: addSeconds(new Date(), 2),
            data: { prefixes, jobGuid: crypto.randomUUID() },
        });
    } else {
        console.log("Evaluator Accuracy Statistics: All prefixes have been processed.");
        await scheduler.runJob<BuildEvaluatorAccuracyStatisticsJobData>({
            name: ControlSubredditJob.EvaluatorAccuracyStatistics,
            runAt: addSeconds(new Date(), 2),
            data: { jobGuid: crypto.randomUUID() },
        });
    }
}

export async function buildEvaluatorAccuracyStatistics (event: TaskRequest<BuildEvaluatorAccuracyStatisticsJobData | undefined>) {
    const jobGuid = event.data?.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Evaluator Accuracy Statistics: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const runLimit = addSeconds(new Date(), 10);
    let processed = 0;
    const processedItems: string[] = [];

    const existingResults = await redis.hGetAll(ACCURACY_STORE);

    const data = _.toPairs(await hGetAllChunked(redis, ACCURACY_QUEUE, 10000));
    while (data.length > 0 && new Date() < runLimit) {
        const record = data.shift();
        if (!record) {
            continue;
        }

        const username = record[0];
        const entry = JSON.parse(record[1]) as AccuracyQueueItem;

        const isBanned = entry.status === UserStatus.Banned;

        const initialEvaluationResults = await getAccountInitialEvaluationResults(username);
        for (const evaluationResult of initialEvaluationResults) {
            const existingRecord = existingResults[getEvaluationResultsKey(evaluationResult)];
            if (existingRecord) {
                const existingData = JSON.parse(existingRecord) as EvaluationAccuracyResult;
                existingData.totalCount++;
                if (isBanned) {
                    existingData.bannedAccounts.push(username);
                    existingData.bannedCount++;
                    if (entry.reportedAt && (!existingData.lastSeen || entry.reportedAt > existingData.lastSeen)) {
                        existingData.lastSeen = entry.reportedAt;
                    }
                } else if (entry.status === UserStatus.Organic) {
                    existingData.unbannedAccounts.push(username);
                }
                existingResults[getEvaluationResultsKey(evaluationResult)] = JSON.stringify(existingData);
            } else {
                const newData: EvaluationAccuracyResult = {
                    totalCount: 1,
                    bannedCount: isBanned ? 1 : 0,
                    bannedAccounts: isBanned ? [username] : [],
                    unbannedAccounts: entry.status === UserStatus.Organic ? [username] : [],
                    lastSeen: isBanned ? entry.reportedAt : undefined,
                };
                existingResults[getEvaluationResultsKey(evaluationResult)] = JSON.stringify(newData);
            }
        }
        processed++;
        processedItems.push(username);
    }

    if (data.length > 0) {
        console.log(`Evaluator Accuracy Statistics: Processed ${processed} records, ${data.length} remaining.`);
        await redis.hSet(ACCURACY_STORE, existingResults);
        if (processedItems.length > 0) {
            await redis.hDel(ACCURACY_QUEUE, processedItems);
        }
        await scheduler.runJob({
            name: ControlSubredditJob.EvaluatorAccuracyStatistics,
            runAt: addSeconds(new Date(), 2),
            data: { firstRun: false, jobGuid: crypto.randomUUID() },
        });
        return;
    }

    // Nothing left in queue. Generate the statistics page.
    const output: json2md.DataObject[] = [];
    output.push({ h1: "Evaluator Accuracy Statistics" });
    output.push({ p: "This page shows the accuracy of the Bot Bouncer evaluation system based on initial evaluations in the last two weeks, taking into account appeals." });

    // eslint-disable-next-line @stylistic/function-paren-newline
    const evaluatorAccuracyStats: Record<string, EvaluationAccuracyResult> = _.fromPairs(
        Object.entries(existingResults).map(([key, value]) => {
            const data = JSON.parse(value) as EvaluationAccuracyResult;
            return [key, {
                totalCount: data.totalCount,
                bannedCount: data.bannedCount,
                bannedAccounts: data.bannedAccounts.slice(-5), // Show only the last 5 banned accounts
                unbannedAccounts: data.unbannedAccounts.slice(-5), // Show only the last 5 unbanned accounts
                lastSeen: data.lastSeen,
            }];
        }));

    const variables = await getEvaluatorVariables();
    const existingEvaluators: string[] = [];
    const nonHitKeys: string[] = [];
    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluator = new Evaluator([], undefined, variables);
        if (evaluator.evaluatorDisabled()) {
            continue;
        }
        const subGroups = evaluator.getSubGroups();
        if (subGroups && subGroups.length > 0) {
            for (const subGroup of subGroups) {
                const key = `${evaluator.name}~${subGroup}`;
                existingEvaluators.push(key);
                if (!Object.keys(evaluatorAccuracyStats).some(item => item.startsWith(evaluator.name) && item.endsWith(subGroup))) {
                    nonHitKeys.push(key);
                }
            }
        } else {
            existingEvaluators.push(evaluator.name);
            if (!Object.keys(evaluatorAccuracyStats).includes(evaluator.name)) {
                nonHitKeys.push(evaluator.name);
            }
        }
    }

    for (const key of nonHitKeys) {
        evaluatorAccuracyStats[key] = {
            totalCount: 0,
            bannedCount: 0,
            bannedAccounts: [],
            unbannedAccounts: [],
        };
    }

    const tableRows: string[][] = [];
    const headers: string[] = ["Bot Name", "Hit Reason", "Last Seen", "Total Count", "Banned Count", "Accuracy (%)", "Example Banned Accounts", "Unbanned Accounts"];

    for (const [key, data] of _.toPairs(evaluatorAccuracyStats).sort((a, b) => a > b ? 1 : -1)) {
        const [botName, hitReason] = key.split("~");
        tableRows.push([
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            botName!,
            hitReason ?? "",
            data.lastSeen ? format(new Date(data.lastSeen), "yyyy-MM-dd") : "",
            data.totalCount.toLocaleString(),
            data.bannedCount.toLocaleString(),
            data.totalCount ? `${Math.floor((data.bannedCount / data.totalCount) * 100)}%` : "",
            data.bannedAccounts.slice(-5).map(account => `/u/${account}`).join(", "),
            data.unbannedAccounts.map(account => `/u/${account}`).join(", "),
        ]);
    };

    if (tableRows.length > 0) {
        output.push({ table: { headers, rows: tableRows } });
    } else {
        output.push({ p: "No evaluation results found." });
    }

    await reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: "statistics/evaluator-accuracy",
        content: json2md(output),
    });

    await redis.del(ACCURACY_QUEUE, ACCURACY_STORE);

    console.log(`Evaluator Accuracy Statistics: Generated statistics page.`);
}
