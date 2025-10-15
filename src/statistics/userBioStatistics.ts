import { JobContext, JSONObject, ScheduledJobEvent, UpdateWikiPageOptions } from "@devvit/public-api";
import { addSeconds, format, subDays, subWeeks } from "date-fns";
import json2md from "json2md";
import { BIO_TEXT_STORE } from "../dataStore.js";
import { getEvaluatorVariable } from "../userEvaluation/evaluatorVariables.js";
import { StatsUserEntry } from "../sixHourlyJobs.js";
import { ControlSubredditJob } from "../constants.js";
import { RedisHelper } from "../redisHelper.js";
import crypto from "crypto";
import { userIsBanned } from "./statsHelpers.js";

const BIO_QUEUE = "BioTextQueue";
const BIO_STATS_TEMP_STORE = "BioTextStatsTempStore";
const BIO_STATS_COUNTS = "BioTextStatsCounts";
const BIO_STATS_SUCCESSFUL_RETRIEVALS = "BioTextStatsSuccessfulRetrievals";

interface BioRecord {
    bioText: string;
    lastSeen: number;
    hits: number;
    users: string[];
    inEvaluators: boolean;
}

function appendedArray (existing: string[], newItem: string, limit = 5): string[] {
    if (existing.includes(newItem)) {
        return existing;
    }
    return [...existing, newItem].slice(-limit);
}

export async function updateBioStatistics (allEntries: StatsUserEntry[], context: JobContext) {
    const recentData = allEntries
        .filter(item => item.data.reportedAt && new Date(item.data.reportedAt) >= subWeeks(new Date(), 2))
        .filter(item => userIsBanned(item.data));

    await context.redis.del(BIO_QUEUE);
    await context.redis.del(BIO_STATS_TEMP_STORE);
    await context.redis.del(BIO_STATS_COUNTS);

    const removedEntries = await context.redis.zRemRangeByScore(BIO_STATS_SUCCESSFUL_RETRIEVALS, 0, subDays(new Date(), 2).getTime());
    if (removedEntries > 0) {
        console.log(`Bio Stats: Removed ${removedEntries} stale entries from successful retrievals`);
    }
    const successfulRetrievalsEntries = await context.redis.zRange(BIO_STATS_SUCCESSFUL_RETRIEVALS, 0, -1);
    console.log(`Bio Stats: ${successfulRetrievalsEntries.length} users have successful bio retrievals recently.`);

    const usersWithBios = new Set(await context.redis.hKeys(BIO_TEXT_STORE));

    const nonretrievableUsers = new Set(await getEvaluatorVariable<string[]>("biotext:nonretrievable", context) ?? []);

    const itemsToProcess = recentData.filter(item => usersWithBios.has(item.username) && !nonretrievableUsers.has(item.username));
    await context.redis.zAdd(BIO_QUEUE, ...itemsToProcess.map(item => ({ member: item.username, score: item.data.reportedAt ?? 0 })));
    console.log(`Bio Stats: queued ${itemsToProcess.length} users for bio stats processing`);

    const configuredBioRegexes = await getEvaluatorVariable<string[]>("biotext:bantext", context) ?? [];

    console.log("Bio Stats: Queueing first bio stats update job");
    await context.scheduler.runJob({
        name: ControlSubredditJob.BioStatsUpdate,
        runAt: addSeconds(new Date(), 5),
        data: { configuredBioRegexes, successfulRetrievalsEntries: successfulRetrievalsEntries.map(item => item.member) },
    });
}

function anyRegexMatches (text: string, regexes: string[]): boolean {
    for (const regex of regexes) {
        if (new RegExp(regex, "u").test(text)) {
            return true;
        }
    }
    return false;
}

function sha1hash (input: string): string {
    return crypto.createHash("sha256").update(input).digest("hex");
}

function encodedBio (input: string): string {
    // Convert input unicode string to base 64 to use as Redis key
    return Buffer.from(input, "utf-8").toString("base64");
}

function decodedBio (input: string): string {
    return Buffer.from(input, "base64").toString("utf-8");
}

export async function updateBioStatisticsJob (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const redisHelper = new RedisHelper(context.redis);
    const configuredBioRegexes = event.data?.configuredBioRegexes as string[] | undefined ?? [];

    let batchSize = 500;

    const queueItems = await context.redis.zRange(BIO_QUEUE, 0, batchSize - 1);
    if (Object.keys(queueItems).length === 0) {
        console.log("Bio Stats: No users in queue, generating report");

        await context.scheduler.runJob({
            name: ControlSubredditJob.BioStatsGenerateReport,
            runAt: addSeconds(new Date(), 2),
            // data: { configuredBioRegexes },
        });
        return;
    }

    console.log("Bio Stats: Running bio statistics gather job");

    const runLimit = addSeconds(new Date(), 15);

    const successfulRetrievalsUsers = event.data?.successfulRetrievalsEntries as string [] | undefined ?? [];
    const usersWithSuccessfulRetrievals = new Set(successfulRetrievalsUsers);

    const queuedUsersWithSuccessfulRetrievals = queueItems.filter(item => usersWithSuccessfulRetrievals.has(item.member)).map(item => item.member);
    if (queuedUsersWithSuccessfulRetrievals.length > 0) {
        console.log(`Bio Stats: ${queuedUsersWithSuccessfulRetrievals.length} users have recent successful retrievals`);
    } else {
        console.log("Bio Stats: No users in queue have recent successful retrievals");
    }

    if (queuedUsersWithSuccessfulRetrievals.length < queueItems.length) {
        batchSize = 100;
    }

    const userBios = await redisHelper.hMGet(BIO_TEXT_STORE, queuedUsersWithSuccessfulRetrievals);

    // const recordsToStore: Record<string, string> = {};
    const recordsToStore = await context.redis.hGetAll(BIO_STATS_TEMP_STORE);

    console.log("Bio Stats: Processing user bios");

    const processed: string[] = [];
    let biosStored = 0;

    const bioTextCounts: Record<string, number> = {};

    while (queueItems.length > 0 && new Date() < runLimit && processed.length < batchSize) {
        const firstEntry = queueItems.shift();
        if (!firstEntry) {
            break;
        }

        const username = firstEntry.member;
        let bioText: string | undefined = userBios[username];
        if (!bioText) {
            console.log(`Bio Stats: Processing bio for user u/${username}`);
            try {
                bioText = await context.redis.hGet(BIO_TEXT_STORE, username);
            } catch (error) {
                console.error(`Bio Stats: Error retrieving bio for u/${username}: ${error}`);
            }
        }

        if (!bioText) {
            processed.push(username);
            continue;
        }

        const hashedText = sha1hash(bioText);

        let existingRecord: BioRecord;
        if (recordsToStore[hashedText]) {
            existingRecord = JSON.parse(recordsToStore[hashedText]) as BioRecord;
        } else {
            const storedRecord = await context.redis.hGet(BIO_STATS_TEMP_STORE, hashedText);
            if (storedRecord) {
                existingRecord = JSON.parse(storedRecord) as BioRecord;
            } else {
                existingRecord = {
                    bioText: encodedBio(bioText),
                    hits: 0,
                    users: [],
                    lastSeen: 0,
                    inEvaluators: anyRegexMatches(bioText, configuredBioRegexes),
                };
            }
        }

        existingRecord.hits += 1;
        existingRecord.users = appendedArray(existingRecord.users, username);
        existingRecord.lastSeen = Math.max(existingRecord.lastSeen, firstEntry.score);
        recordsToStore[hashedText] = JSON.stringify(existingRecord);
        biosStored++;

        bioTextCounts[hashedText] = existingRecord.hits;

        processed.push(username);
    }

    if (processed.length > 0) {
        await context.redis.zRem(BIO_QUEUE, processed);
        await context.redis.zAdd(BIO_STATS_SUCCESSFUL_RETRIEVALS, ...processed.map(username => ({ member: username, score: Date.now() })));
    }

    const bioTextCountEntries = Object.entries(bioTextCounts).map(([encodedBioText, count]) => ({ member: encodedBioText, score: count }));
    if (bioTextCountEntries.length > 0) {
        console.log(`Bio Stats: Updating counts for ${bioTextCountEntries.length} bio texts with multiple hits`);
        await context.redis.zAdd(BIO_STATS_COUNTS, ...bioTextCountEntries);
    }

    if (Object.keys(recordsToStore).length > 0) {
        await context.redis.hSet(BIO_STATS_TEMP_STORE, recordsToStore);
    }

    console.log(`Bio Stats: Processed ${processed.length} users, stored bios for ${biosStored} users`);

    await context.scheduler.runJob({
        name: ControlSubredditJob.BioStatsUpdate,
        runAt: addSeconds(new Date(), 2),
        data: { configuredBioRegexes, successfulRetrievalsEntries: successfulRetrievalsUsers },
    });
}

export async function generateBioStatisticsReport (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    console.log("Bio Stats: Generating bio statistics report");

    const redisHelper = new RedisHelper(context.redis);

    const itemsWithMoreThanOne = await redisHelper.zRangeAsRecord(BIO_STATS_COUNTS, 2, "+inf", { by: "score" });
    const bioRecords = await redisHelper.hMGet(BIO_STATS_TEMP_STORE, Object.keys(itemsWithMoreThanOne));
    console.log(`Bio Stats: Retrieved ${Object.keys(bioRecords).length} bio records for report generation`);

    const configuredBioRegexes = event.data?.configuredBioRegexes as string[] | undefined ?? [];

    const reusedRecords = Object.entries(bioRecords)
        .map(([bioText, record]) => ({ bioText: decodedBio(bioText), record: JSON.parse(record) as BioRecord }));

    if (reusedRecords.length === 0) {
        console.log("Bio Stats: No reused bio texts found, skipping report generation");
        return;
    }

    console.log(`Bio Stats: Found ${reusedRecords.length} reused bio texts`);

    reusedRecords.sort((a, b) => b.record.hits - a.record.hits);

    console.log("Bio Stats: Sorted records. Generating report content");

    const content: json2md.DataObject[] = [];

    const notCoveredByEvaluatorData: json2md.DataObject[] = [];
    const coveredByEvaluatorData: json2md.DataObject[] = [];

    content.push({ h1: "User Bio Text" });
    for (const record of reusedRecords) {
        const currentContent: json2md.DataObject[] = [];

        currentContent.push({ blockquote: decodedBio(record.record.bioText) });
        const listRows: string[] = [];

        listRows.push(
            `Last seen: ${format(record.record.lastSeen, "MMM dd")}`,
            `Distinct users: ${record.record.hits}`,
        );
        listRows.push(`Example users: ${record.record.users.slice(-5).map(user => `u/${user}`).join(", ")}`);

        currentContent.push({ ul: listRows });
        currentContent.push({ hr: {} });

        if (record.record.inEvaluators) {
            coveredByEvaluatorData.push(...currentContent);
        } else {
            if (record.record.lastSeen > subWeeks(new Date(), 1).getTime()) {
                notCoveredByEvaluatorData.push(...currentContent);
            }
        }
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
            if (!reusedRecords.some(record => new RegExp(regex, "u").exec(decodedBio(record.record.bioText)))) {
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

    await context.redis.del(BIO_QUEUE);
    await context.redis.del(BIO_STATS_TEMP_STORE);
    await context.redis.del(BIO_STATS_COUNTS);

    console.log("Bio Stats: Completed bio statistics report generation and cleanup");
}
