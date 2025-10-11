import { JobContext, UpdateWikiPageOptions } from "@devvit/public-api";
import { addSeconds, format, subWeeks } from "date-fns";
import json2md from "json2md";
import { BIO_TEXT_STORE, UserStatus } from "../dataStore.js";
import { getEvaluatorVariable } from "../userEvaluation/evaluatorVariables.js";
import { StatsUserEntry } from "../sixHourlyJobs.js";
import { ControlSubredditJob } from "../constants.js";
import { RedisHelper } from "../redisHelper.js";

const BIO_QUEUE = "BioTextQueue";
const BIO_STATS_TEMP_STORE = "BioTextStatsTempStore";

interface BioRecord {
    lastSeen: number;
    hits: number;
    users: string[];
}

function appendedArray (existing: string[], newItems: string[], limit = 5): string[] {
    return Array.from(new Set([...existing, ...newItems])).filter(item => !item.startsWith("u_")).slice(-limit);
}

export async function updateBioStatistics (allEntries: StatsUserEntry[], context: JobContext) {
    const recentData = allEntries
        .filter(item => item.data.reportedAt && new Date(item.data.reportedAt) >= subWeeks(new Date(), 2))
        .filter(item => item.data.userStatus === UserStatus.Banned || item.data.lastStatus === UserStatus.Banned);

    await context.redis.del(BIO_QUEUE);
    await context.redis.del(BIO_STATS_TEMP_STORE);

    await context.redis.zAdd(BIO_QUEUE, ...recentData.map(item => ({ member: item.username, score: item.data.reportedAt ?? 0 })));
    console.log(`Bio Stats: queued ${recentData.length} users for bio stats processing`);

    await context.scheduler.runJob({
        name: ControlSubredditJob.BioStatsUpdate,
        runAt: new Date(),
    });
}

export async function updateBioStatisticsJob (_: unknown, context: JobContext) {
    const redisHelper = new RedisHelper(context.redis);

    const queueItems = await redisHelper.zRangeAsRecord(BIO_QUEUE, 0, 1999);
    if (Object.keys(queueItems).length === 0) {
        console.log("Bio Stats: No users in queue, generating report");
        await context.scheduler.runJob({
            name: ControlSubredditJob.BioStatsGenerateReport,
            runAt: new Date(),
        });
        return;
    }

    console.log("Bio Stats: Running bio statistics gather job");

    const runLimit = addSeconds(new Date(), 15);

    const userBios = await redisHelper.hMGet(BIO_TEXT_STORE, Object.keys(queueItems));
    const recordsToStore = await redisHelper.hMGet(BIO_STATS_TEMP_STORE, Object.values(userBios));

    const userBioEntries = Object.entries(userBios).map(([username, bioText]) => ({ username, bioText }));

    const usersWithoutBios = Object.keys(queueItems).filter(username => !userBios[username]);
    if (usersWithoutBios.length > 0) {
        console.log(`Bio Stats: Removing ${usersWithoutBios.length} users without bios from queue`);
        await context.redis.zRem(BIO_QUEUE, usersWithoutBios);
    }

    const processed: string[] = [];
    while (userBioEntries.length > 0 && new Date() < runLimit) {
        const firstEntry = userBioEntries.shift();
        if (!firstEntry) {
            break;
        }
        const { username, bioText } = firstEntry;
        if (!recordsToStore[bioText]) {
            const newRecord: BioRecord = { hits: 1, users: [username], lastSeen: queueItems[username] };
            recordsToStore[bioText] = JSON.stringify(newRecord);
        } else {
            const existingRecord = JSON.parse(recordsToStore[bioText]) as BioRecord;
            existingRecord.hits += 1;
            existingRecord.users = appendedArray(existingRecord.users, [username]);
            existingRecord.lastSeen = Math.max(existingRecord.lastSeen, queueItems[username]);
            recordsToStore[bioText] = JSON.stringify(existingRecord);
        }

        processed.push(username);
    }

    if (processed.length > 0) {
        await context.redis.hSet(BIO_STATS_TEMP_STORE, recordsToStore);
        await context.redis.zRem(BIO_QUEUE, processed);
    }

    console.log(`Bio Stats: Processed ${processed.length} users`);

    await context.scheduler.runJob({
        name: ControlSubredditJob.BioStatsUpdate,
        runAt: addSeconds(new Date(), 1),
    });
}

export async function generateBioStatisticsReport (_: unknown, context: JobContext) {
    const bioRecords = await context.redis.hGetAll(BIO_STATS_TEMP_STORE);

    const reusedRecords = Object.entries(bioRecords)
        .map(([bioText, record]) => ({ bioText, record: JSON.parse(record) as BioRecord }))
        .filter(record => record.record.hits > 1);

    if (reusedRecords.length === 0) {
        console.log("Bio Stats: No reused bio texts found, skipping report generation");
        return;
    }

    console.log(`Bio Stats: Found ${reusedRecords.length} reused bio texts`);

    reusedRecords.sort((a, b) => b.record.hits - a.record.hits);

    console.log("Bio Stats: Sorted records. Generating report content");
    const configuredBioRegexes = await getEvaluatorVariable<string[]>("biotext:bantext", context) ?? [];
    console.log(`Bio Stats: Retrieved ${configuredBioRegexes.length} configured bio regexes`);

    const content: json2md.DataObject[] = [];

    const notCoveredByEvaluatorData: json2md.DataObject[] = [];
    const coveredByEvaluatorData: json2md.DataObject[] = [];

    console.log("Bio Stats: Starting to build report content");

    content.push({ h1: "User Bio Text" });
    for (const record of reusedRecords) {
        const currentContent: json2md.DataObject[] = [];

        console.log(`Bio Stats: Processing record with bio text: ${record.bioText}`);
        currentContent.push({ blockquote: record.bioText });
        const listRows: string[] = [];

        listRows.push(
            `Last seen: ${format(record.record.lastSeen, "MMM dd")}`,
            `Distinct users: ${record.record.hits}`,
        );
        listRows.push(`Example users: ${record.record.users.slice(-5).map(user => `u/${user}`).join(", ")}`);

        currentContent.push({ ul: listRows });
        currentContent.push({ hr: {} });

        if (!configuredBioRegexes.some(regex => new RegExp(regex, "u").exec(record.bioText))) {
            if (record.record.lastSeen > subWeeks(new Date(), 1).getTime()) {
                notCoveredByEvaluatorData.push(...currentContent);
            }
        } else {
            coveredByEvaluatorData.push(...currentContent);
        }

        console.log(`Bio Stats: Processed record with ${record.record.hits} hits`);
    }

    content.push({ h2: "Bio text not covered by Evaluator configuration and seen in the last week" });
    if (notCoveredByEvaluatorData.length === 0) {
        content.push({ p: "None" });
    } else {
        content.push(...notCoveredByEvaluatorData);
    }

    content.push({ h2: "Bio text covered by Evaluator configuration and seen in the last two weeks" });
    if (coveredByEvaluatorData.length === 0) {
        content.push({ p: "None" });
    } else {
        content.push(...coveredByEvaluatorData);
    }

    if (configuredBioRegexes.length > 0) {
        const bullets: string[] = [];
        for (const regex of configuredBioRegexes) {
            if (!reusedRecords.some(record => new RegExp(regex, "u").exec(record.bioText))) {
                bullets.push(`\`${regex}\``);
            }
        }

        if (bullets.length > 0) {
            content.push({ h2: "Regexes not seen in the last two weeks" });
            content.push({ p: "The following bio regexes are in the Evaluator Configuration but have not been seen in the last two weeks:" });
            content.push({ ul: bullets });
        }
    }

    console.log("Bio Stats: Updating bio statistics wiki page");
    const wikiUpdateData: UpdateWikiPageOptions = {
        subredditName: "botbouncer",
        page: "statistics/biotext",
        content: json2md(content),
    };

    console.log(`Bio Stats: Queueing wiki update job for biotext stats`);
    await context.scheduler.runJob({
        name: ControlSubredditJob.AsyncWikiUpdate,
        data: wikiUpdateData,
        runAt: new Date(),
    });

    await context.redis.del(BIO_STATS_TEMP_STORE);
    await context.redis.del(BIO_QUEUE);

    console.log("Bio Stats: Completed bio statistics report generation and cleanup");
}
