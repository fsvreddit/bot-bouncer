import { redis, scheduler, TaskRequest, UpdateWikiPageOptions } from "@devvit/web/server";
import { addHours, addMinutes, addSeconds, format, subWeeks } from "date-fns";
import json2md from "json2md";
import { StatsUserEntry, userIsBanned } from "./statsHelpers";
import { BIO_TEXT_STORE, ControlSubredditJob, decodedText, encodedText, expireKeyAt, hGetAllChunked, hMGetAsRecord, hSetChunked, zRangeAsRecord } from "../..";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { getEvaluatorVariable, getRedisSubstitionValue, setRedisSubstititionValue } from "../../userEvaluation";
import escapeStringRegexp from "escape-string-regexp";
import { BioStatsJobData } from "../../../tasks";
import { createHash } from "node:crypto";
import _ from "lodash";

const BIO_STATS_UPDATE_IN_PROGRESS = "BioTextStatsUpdateInProgressKey";

function getBioQueueKey (statsId: string): string {
    return `bioTextQueue:${statsId}`;
}

function getBioStatsTempStoreKey (statsId: string): string {
    return `bioTextStatsTempStore:${statsId}`;
}

function getBioStatsCountsKey (statsId: string): string {
    return `bioTextStatsCounts:${statsId}`;
}

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

async function clearDownTemporaryKeys (statsId: string) {
    await redis.del(getBioQueueKey(statsId), getBioStatsTempStoreKey(statsId), getBioStatsCountsKey(statsId));
}

export async function updateBioStatistics (allEntries: StatsUserEntry[]) {
    if (await redis.exists(BIO_STATS_UPDATE_IN_PROGRESS)) {
        console.log("Bio Stats: Update already in progress, skipping this run");
        return;
    }

    const statsId = Date.now().toString();

    const recentData = allEntries
        .filter(item => item.data.reportedAt && new Date(item.data.reportedAt) >= subWeeks(new Date(), 4))
        .filter(item => userIsBanned(item.data));

    await clearDownTemporaryKeys(statsId);

    const chunkedData = _.chunk(recentData, 20000);

    await Promise.all(chunkedData.map(entries => redis.zAdd(getBioQueueKey(statsId), ...entries.map(item => ({ member: item.username, score: item.data.reportedAt ?? 0 })))));
    await expireKeyAt(getBioQueueKey(statsId), addHours(new Date(), 1));

    console.log(`Bio Stats: queued ${recentData.length} users for bio stats processing`);

    console.log("Bio Stats: Queueing first bio stats update job");
    await scheduler.runJob<BioStatsJobData>({
        name: ControlSubredditJob.BioStatsUpdate,
        runAt: addSeconds(new Date(), 5),
        data: { statsId, jobGuid: crypto.randomUUID() },
    });
}

function anyRegexMatches (text: string, regexes: RegExp[]): boolean {
    for (const regex of regexes) {
        const start = Date.now();
        const matched = regex.test(text);
        if (Date.now() - start > 100) {
            console.warn(`Regex test took longer than 100ms for text: ${text}, regex: ${regex.source}`);
        }
        if (matched) {
            return true;
        }
    }
    return false;
}

function sha1hash (input: string): string {
    return createHash("sha256").update(input).digest("hex");
}

export async function updateBioStatisticsJob (event: TaskRequest<BioStatsJobData>) {
    const jobGuid = event.data.jobGuid as string | undefined;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Update Bio Statistics Job: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    await redis.set(BIO_STATS_UPDATE_IN_PROGRESS, "true", { expiration: addSeconds(new Date(), 30) });

    const batchSize = 15000;

    const statsId = event.data.statsId;

    const queueItems = await redis.zRange(getBioQueueKey(statsId), 0, batchSize - 1);
    if (Object.keys(queueItems).length === 0) {
        console.log("Bio Stats: No users in queue, generating report");

        await scheduler.runJob<BioStatsJobData>({
            name: ControlSubredditJob.BioStatsGenerateReport,
            runAt: addSeconds(new Date(), 2),
            data: {
                statsId,
                jobGuid: crypto.randomUUID(),
            },
        });
        return;
    }

    const batch = event.data.batch ?? 1;
    console.log(`Bio Stats: Running bio statistics gather job (batch ${batch})`);

    const runLimit = addSeconds(new Date(), 10);

    const configuredBioRegexes = (await getEvaluatorVariable<string[]>("biotext:bantext") ?? []).map(entry => new RegExp(entry, "u"));
    const entriesToAllowlist = (await getEvaluatorVariable<string[]>("biotext:entriesToAllowlist") ?? []).map(entry => new RegExp(entry, "u"));

    const userBios = await hMGetAsRecord(redis, BIO_TEXT_STORE, queueItems.map(item => item.member));

    const recordsToStore = await hGetAllChunked(redis, getBioStatsTempStoreKey(statsId));

    console.log(`Bio Stats: Processing user bios (batch ${batch})`);

    const processed: string[] = [];
    let biosStored = 0;

    const bioTextCounts: Record<string, number> = {};

    while (queueItems.length > 0 && new Date() < runLimit && processed.length < batchSize) {
        const firstEntry = queueItems.shift();
        if (!firstEntry) {
            break;
        }

        const username = firstEntry.member;
        const bioText: string | undefined = userBios[username];

        if (!bioText || bioText.trim().length < 4) {
            processed.push(username);
            continue;
        }

        if (entriesToAllowlist.some(regex => regex.test(bioText))) {
            processed.push(username);
            continue;
        }

        const hashedText = sha1hash(bioText);

        let existingRecord: BioRecord;
        if (recordsToStore[hashedText]) {
            existingRecord = JSON.parse(recordsToStore[hashedText]) as BioRecord;
        } else {
            existingRecord = {
                bioText: encodedText(bioText),
                hits: 0,
                users: [],
                lastSeen: 0,
                inEvaluators: anyRegexMatches(bioText, configuredBioRegexes),
            };
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
        await redis.zRem(getBioQueueKey(statsId), processed);
    }

    const bioTextCountEntries = Object.entries(bioTextCounts).map(([encodedBioText, count]) => ({ member: encodedBioText, score: count }));
    if (bioTextCountEntries.length > 0) {
        console.log(`Bio Stats: Updating counts for ${bioTextCountEntries.length} bio texts with multiple hits`);
        await redis.zAdd(getBioStatsCountsKey(statsId), ...bioTextCountEntries);
        await expireKeyAt(getBioStatsCountsKey(statsId), addHours(new Date(), 1));
    }

    if (Object.keys(recordsToStore).length > 0) {
        await hSetChunked(redis, getBioStatsTempStoreKey(statsId), recordsToStore);
        await expireKeyAt(getBioStatsTempStoreKey(statsId), addHours(new Date(), 1));
    }

    console.log(`Bio Stats: Processed ${processed.length} users, stored bios for ${biosStored} users, batch ${batch} complete.`);

    await scheduler.runJob<BioStatsJobData>({
        name: ControlSubredditJob.BioStatsUpdate,
        runAt: addSeconds(new Date(), 1),
        data: {
            statsId,
            batch: batch + 1,
            jobGuid: crypto.randomUUID(),
        },
    });
}

export async function generateBioStatisticsReport (event: TaskRequest<BioStatsJobData>) {
    console.log("Bio Stats: Generating bio statistics report");

    const statsId = event.data.statsId;
    if (!statsId) {
        console.error("Bio Stats: No statsId provided in job data, cannot generate report");
        return;
    }

    const itemsWithMoreThanOne = await zRangeAsRecord(redis, getBioStatsCountsKey(statsId), 5, "+inf", { by: "score" });

    for (let i = 4; i > 1; i--) {
        const additionalItems = await zRangeAsRecord(redis, getBioStatsCountsKey(statsId), i, i, { by: "score" });
        Object.assign(itemsWithMoreThanOne, additionalItems);
    }

    const bioRecords = await hMGetAsRecord(redis, getBioStatsTempStoreKey(statsId), Object.keys(itemsWithMoreThanOne));
    console.log(`Bio Stats: Retrieved ${Object.keys(bioRecords).length} bio records for report generation`);

    const configuredBioRegexes = await getEvaluatorVariable<string[]>("biotext:bantext") ?? [];

    const reusedRecords = Object.entries(bioRecords)
        .map(([bioText, record]) => ({ bioText: decodedText(bioText), record: JSON.parse(record) as BioRecord }));

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

    const distinctBiosSet = new Set<string>();

    content.push({ h1: "User Bio Text" });
    content.push({ p: "You generally don't need to action any of these directly. The exception is for short bios which are not added to the configuration automatically for safety reasons. " });
    for (const record of reusedRecords) {
        const currentContent: json2md.DataObject[] = [];
        const bioText = decodedText(record.record.bioText);
        currentContent.push({ blockquote: bioText });
        distinctBiosSet.add(bioText);
        const listRows: string[] = [];

        listRows.push(
            `Last seen: ${format(record.record.lastSeen, "MMM dd")}`,
            `Distinct users: ${record.record.hits}`,
        );
        listRows.push(`Example users: ${record.record.users.slice(-5).map(user => `u/${user}`).join(", ")}`);

        currentContent.push({ ul: listRows });
        currentContent.push({ hr: {} });

        if (record.record.inEvaluators) {
            if (record.record.hits > 3) {
                coveredByEvaluatorData.push(...currentContent);
            }
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

    content.push({ h2: "Bio text covered by Evaluator configuration and seen in the last four weeks" });
    content.push({ p: "Now only shows entries used more than three times." });
    if (coveredByEvaluatorData.length === 0) {
        content.push({ p: "None" });
    } else {
        content.push(...coveredByEvaluatorData);
    }

    if (configuredBioRegexes.length > 0) {
        const bullets: string[] = [];
        for (const regex of configuredBioRegexes) {
            if (!reusedRecords.some(record => new RegExp(regex, "u").exec(decodedText(record.record.bioText)))) {
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
    await scheduler.runJob<UpdateWikiPageOptions>({
        name: ControlSubredditJob.AsyncWikiUpdate,
        data: wikiUpdateData,
        runAt: new Date(),
    });

    await clearDownTemporaryKeys(statsId);
    await redis.del(BIO_STATS_UPDATE_IN_PROGRESS);
    console.log("Bio Stats: Completed bio statistics report generation and cleanup");

    const distinctBios = Array.from(distinctBiosSet)
        .filter(bio => bio.split(" ").length > 3 || bio.length > 15)
        .map(bio => `^${escapeStringRegexp(bio)}$`);

    const existingSubstitionValue = new Set(await getRedisSubstitionValue<string[]>("biotext") ?? []);

    if (distinctBios.length === existingSubstitionValue.size && distinctBios.every(value => existingSubstitionValue.has(value))) {
        return;
    }

    await setRedisSubstititionValue("biotext", distinctBios);
    console.log(`Bio Stats: Updated biotext substitution value with ${distinctBios.length} entries`);
}
