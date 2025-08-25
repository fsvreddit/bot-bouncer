import { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { getFullDataStore, UserDetails, UserStatus } from "../dataStore.js";
import { fromPairs, toPairs } from "lodash";
import { addSeconds, format, subDays } from "date-fns";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import { EvaluationResult, getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import { ALL_EVALUATORS } from "@fsvreddit/bot-bouncer-evaluation";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";

const ACCURACY_QUEUE = "evaluatorAccuracyQueue";
const ACCURACY_STORE = "evaluatorAccuracyStore";

interface AccuracyQueueItem {
    status: UserStatus;
    reportedAt?: number;
}

function dateInRange (date: Date): boolean {
    return date > subDays(new Date(), 14);
}

async function gatherUsernames (context: JobContext) {
    const fullDataStore = await getFullDataStore(context);
    const parsed = toPairs(fullDataStore).map(([username, data]) => ({ username, data: JSON.parse(data) as UserDetails }));
    const relevantData = parsed.filter((item) => {
        const date = item.data.reportedAt ? new Date(item.data.reportedAt) : undefined;
        if (!date) {
            return false;
        }

        if (!dateInRange(date)) {
            return false;
        }

        return true;
    });

    const recordsToQueue = fromPairs(relevantData.map((item) => {
        let itemToQueue: AccuracyQueueItem;
        if (item.data.userStatus === UserStatus.Purged || item.data.userStatus === UserStatus.Retired) {
            itemToQueue = { status: item.data.lastStatus ?? item.data.userStatus, reportedAt: item.data.reportedAt };
        } else {
            itemToQueue = { status: item.data.userStatus, reportedAt: item.data.reportedAt };
        }
        return [item.username, JSON.stringify(itemToQueue)];
    }));

    await context.redis.hSet(ACCURACY_QUEUE, recordsToQueue);
    console.log(`Evaluator Accuracy Statistics: Queued ${relevantData.length} usernames for accuracy evaluation.`);
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
        return `${evaluationResult.botName}~${evaluationResult.hitReason}`;
    } else {
        return evaluationResult.botName;
    }
}

export async function buildEvaluatorAccuracyStatistics (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    if (event.data?.firstRun) {
        console.log("Evaluator Accuracy Statistics: First run, gathering usernames.");
        await context.redis.del(ACCURACY_QUEUE);
        await context.redis.del(ACCURACY_STORE);
        await gatherUsernames(context);
        await context.scheduler.runJob({
            name: ControlSubredditJob.EvaluatorAccuracyStatistics,
            runAt: addSeconds(new Date(), 2),
            data: { firstRun: false },
        });
        return;
    }

    const runLimit = addSeconds(new Date(), 10);
    let processed = 0;
    const processedItems: string[] = [];

    const existingResults = await context.redis.hGetAll(ACCURACY_STORE);

    const data = toPairs(await context.redis.hGetAll(ACCURACY_QUEUE));
    while (data.length > 0 && new Date() < runLimit) {
        const record = data.shift();
        if (!record) {
            continue;
        }

        const username = record[0];
        const entry = JSON.parse(record[1]) as AccuracyQueueItem;

        const isBanned = entry.status === UserStatus.Banned;

        const initialEvaluationResults = await getAccountInitialEvaluationResults(username, context);
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
        await context.redis.hSet(ACCURACY_STORE, existingResults);
        await context.redis.hDel(ACCURACY_QUEUE, processedItems);
        await context.scheduler.runJob({
            name: ControlSubredditJob.EvaluatorAccuracyStatistics,
            runAt: addSeconds(new Date(), 2),
            data: { firstRun: false },
        });
        return;
    }

    // Nothing left in queue. Generate the statistics page.
    const output: json2md.DataObject[] = [];
    output.push({ h1: "Evaluator Accuracy Statistics" });
    output.push({ p: "This page shows the accuracy of the Bot Bouncer evaluation system based on initial evaluations in the last two weeks, taking into account appeals." });

    // eslint-disable-next-line @stylistic/function-paren-newline
    const evaluatorAccuracyStats: Record<string, EvaluationAccuracyResult> = fromPairs(
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

    const variables = await getEvaluatorVariables(context);
    const existingEvaluators: string[] = [];
    const nonHitKeys: string[] = [];
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluator = new Evaluator(context, undefined, variables);
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

    for (const [key, data] of toPairs(evaluatorAccuracyStats).sort((a, b) => a > b ? 1 : -1)) {
        const [botName, hitReason] = key.split("~");
        tableRows.push([
            botName,
            hitReason || "",
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

    await context.reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: "statistics/evaluator-accuracy",
        content: json2md(output),
    });

    await context.redis.del(ACCURACY_QUEUE);
    await context.redis.del(ACCURACY_STORE);

    console.log(`Evaluator Accuracy Statistics: Generated statistics page.`);
}
