import { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { getFullDataStore, UserDetails, UserStatus } from "../dataStore.js";
import { fromPairs, toPairs } from "lodash";
import { addSeconds, subDays } from "date-fns";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import { EvaluationResult, getAccountInitialEvaluationResults } from "../handleControlSubAccountEvaluation.js";
import json2md from "json2md";

const ACCURACY_QUEUE = "evaluatorAccuracyQueue";
const ACCURACY_STORE = "evaluatorAccuracyStore";

function dateInRange (date: Date): boolean {
    return date < subDays(new Date(), 2) && date > subDays(new Date(), 9);
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

        if (item.data.userStatus === UserStatus.Purged || item.data.userStatus === UserStatus.Retired) {
            return false;
        }

        return true;
    });

    const recordsToQueue = fromPairs(relevantData.map(({ username, data }) => ([username, data.userStatus])));
    await context.redis.hSet(ACCURACY_QUEUE, recordsToQueue);
    console.log(`Evaluator Accuracy Statistics: Queued ${relevantData.length} usernames for accuracy evaluation.`);
}

interface EvaluationAccuracyResult {
    totalCount: number;
    bannedCount: number;
    bannedAccounts: string[];
    unbannedAccounts: string[];
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

    const runLimit = addSeconds(new Date(), 25);
    let processed = 0;

    const existingResults = await context.redis.hGetAll(ACCURACY_STORE);

    const data = toPairs(await context.redis.hGetAll(ACCURACY_QUEUE));
    while (data.length > 0 && new Date() < runLimit) {
        const record = data.shift();
        if (!record) {
            continue;
        }
        const [username, status] = record;
        const isBanned = status === UserStatus.Banned as string;

        const initialEvaluationResults = await getAccountInitialEvaluationResults(username, context);
        for (const evaluationResult of initialEvaluationResults) {
            const existingRecord = existingResults[getEvaluationResultsKey(evaluationResult)];
            if (existingRecord) {
                const existingData = JSON.parse(existingRecord) as EvaluationAccuracyResult;
                existingData.totalCount++;
                if (isBanned) {
                    existingData.bannedAccounts.push(username);
                    existingData.bannedCount++;
                } else if (status === UserStatus.Organic as string) {
                    existingData.unbannedAccounts.push(username);
                }
                existingResults[getEvaluationResultsKey(evaluationResult)] = JSON.stringify(existingData);
            } else {
                const newData: EvaluationAccuracyResult = {
                    totalCount: 1,
                    bannedCount: isBanned ? 1 : 0,
                    bannedAccounts: isBanned ? [username] : [],
                    unbannedAccounts: status === UserStatus.Organic as string ? [username] : [],
                };
                existingResults[getEvaluationResultsKey(evaluationResult)] = JSON.stringify(newData);
            }
        }
        processed++;
    }

    if (data.length > 0) {
        console.log(`Evaluator Accuracy Statistics: Processed ${processed} records, ${data.length} remaining.`);
        await context.redis.hSet(ACCURACY_STORE, existingResults);
        await context.scheduler.runJob({
            name: ControlSubredditJob.EvaluatorAccuracyStatistics,
            runAt: addSeconds(new Date(), 2),
            data: { firstRun: false },
        });
    }

    // Nothing left in queue. Generate the statistics page.
    const output: json2md.DataObject[] = [];
    output.push({ h1: "Evaluator Accuracy Statistics" });
    output.push({ p: "This page shows the accuracy of the Bot Bouncer evaluation system based on initial evaluations in the last week, taking into account appeals." });

    const tableRows: string[][] = [];
    const headers: string[] = ["Bot Name", "Hit Reason", "Total Count", "Banned Count", "Accuracy (%)", "Example Banned Accounts", "Unbanned Accounts"];

    for (const [key, value] of toPairs(existingResults).sort((a, b) => a > b ? 1 : -1)) {
        const [botName, hitReason] = key.split("~");
        const data = JSON.parse(value) as EvaluationAccuracyResult;
        tableRows.push([
            botName,
            hitReason || "",
            data.totalCount.toLocaleString(),
            data.bannedCount.toLocaleString(),
            `${Math.floor((data.bannedCount / data.totalCount) * 100)}%`,
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
