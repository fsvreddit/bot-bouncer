import { JobContext, JSONObject, ScheduledJobEvent } from "@devvit/public-api";
import { ControlSubredditJob } from "../constants.js";
import { ALL_EVALUATORS, EvaluatorRegex } from "@fsvreddit/bot-bouncer-evaluation";
import { getEvaluatorVariables } from "./evaluatorVariables.js";
import { addMinutes, addSeconds } from "date-fns";
import { isSafe } from "redos-detector";
import { decodedText, encodedText, replaceAll } from "../utility.js";
import { RedisHelper } from "../redisHelper.js";
import json2md from "json2md";

const REDOS_QUEUE_KEY = "evaluatorRedosQueue";
const REDOS_HITS_KEY = "evaluatorRedosHits";

async function queueRedosCheckEntries (context: JobContext) {
    const evaluatorVariables = await getEvaluatorVariables(context);
    let entriesAdded = 0;
    for (const Evaluator of ALL_EVALUATORS) {
        const evaluatorInstance = new Evaluator(context, undefined, evaluatorVariables);
        const evaluatorRegexes = evaluatorInstance.gatherRegexes();
        if (evaluatorRegexes.length === 0) {
            continue;
        }
        entriesAdded += await context.redis.zAdd(REDOS_QUEUE_KEY, ...evaluatorRegexes.map(regex => ({ member: encodedText(JSON.stringify(regex)), score: Date.now() })));
        const redisHelper = new RedisHelper(context.redis);
        await redisHelper.expireAt(REDOS_QUEUE_KEY, addMinutes(new Date(), 30));
    }

    console.log(`ReDoS Checker: Queued ${entriesAdded.toLocaleString()} regex entries for checking.`);
}

export async function redosChecker (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const inProgressKey = "redosCheckerInProgress";

    if (event.data?.firstRun) {
        if (await context.redis.exists(inProgressKey)) {
            console.log("ReDoS Checker: Previous run still in progress, skipping this run.");
            return;
        }

        await context.redis.del(REDOS_QUEUE_KEY);
        await context.redis.del(REDOS_HITS_KEY);

        await queueRedosCheckEntries(context);
        await context.scheduler.runJob({
            name: ControlSubredditJob.EvaluatorReDoSChecker,
            runAt: addSeconds(new Date(), 2),
            data: { firstRun: false, modName: event.data.modName },
        });

        return;
    }

    if (event.data?.finalise) {
        await finaliseReDosReport(context);
        return;
    }

    await context.redis.set(inProgressKey, "true", { expiration: addSeconds(new Date(), 60) });
    const batchNumber = event.data?.batchNumber as number | undefined ?? 1;
    const batchSize = 50;
    console.log(`ReDoS Checker: Starting batch #${batchNumber}...`);

    const runLimit = addSeconds(new Date(), 10);
    const remainingEntries = await context.redis.zCard(REDOS_QUEUE_KEY);
    console.log(`ReDoS Checker: ${remainingEntries.toLocaleString()} entries remaining in queue.`);

    const redosQueue = await context.redis.zRange(REDOS_QUEUE_KEY, 0, batchSize - 1).then(entries => entries.map(entry => entry.member));
    console.log(`ReDoS Checker: Processing up to ${redosQueue.length} entries in this batch.`);

    const processed: string[] = [];

    while (redosQueue.length > 0 && new Date() < runLimit) {
        const entry = redosQueue.shift();
        if (!entry) {
            break;
        }

        const regexEntry = JSON.parse(decodedText(entry)) as EvaluatorRegex;

        let regex: RegExp | undefined;
        try {
            regex = new RegExp(regexEntry.regex, regexEntry.flags);
        } catch {
            console.warn(`ReDoS Checker: Invalid regex /${regexEntry.regex}/${regexEntry.flags ?? ""}, skipping.`);
            processed.push(entry);
            continue;
        }

        try {
            const safeResult = isSafe(regex, { maxScore: 500, timeout: 1000 });
            if (!safeResult.safe) {
                await context.redis.zAdd(REDOS_HITS_KEY, ({ member: entry, score: Date.now() }));

                // TODO: Notify via webhook
            }
        } catch (error) {
            console.error(`ReDoS Checker: Error checking regex /${regexEntry.regex}/${regexEntry.flags ?? ""}:`, error);
        }

        processed.push(entry);
    }

    if (processed.length > 0) {
        await context.redis.zRem(REDOS_QUEUE_KEY, processed);
    }

    console.log(`ReDoS Checker: Processed ${processed.length} entries, ${remainingEntries - processed.length} remaining, batch #${batchNumber} complete.`);

    if (remainingEntries > processed.length) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.EvaluatorReDoSChecker,
            runAt: addSeconds(new Date(), 2),
            data: {
                firstRun: false,
                modName: event.data?.modName ?? "unknown",
                batchNumber: batchNumber + 1,
            },
        });
    } else {
        console.log("ReDoS Checker: Completed all entries.");
        await context.scheduler.runJob({
            name: ControlSubredditJob.EvaluatorReDoSChecker,
            runAt: addSeconds(new Date(), 5),
            data: {
                finalise: true,
            },
        });
    }
}

async function finaliseReDosReport (context: JobContext) {
    const redosHits = await context.redis.zRange(REDOS_HITS_KEY, 0, -1).then(entries => entries.map(entry => JSON.parse(decodedText(entry.member)) as EvaluatorRegex));

    const wikiPageName = "statistics/redos-detections";

    const wikiContent: json2md.DataObject[] = [
        { h1: "ReDoS Detections Report" },
        { p: `This report lists all regular expressions used by evaluators that have been identified as potentially vulnerable to Regular Expression Denial of Service (ReDoS) attacks. A total of ${redosHits.length.toLocaleString()} vulnerable regex patterns were detected.` },
    ];

    if (redosHits.length > 0) {
        const tableRows = redosHits.map(hit => ([
            hit.evaluatorName,
            hit.subName ?? "",
            `\`${replaceAll(hit.regex.length > 100 ? hit.regex.slice(0, 100) + "…" : hit.regex, "|", "¦")}\``,
        ]));

        wikiContent.push({
            table: {
                headers: ["Evaluator Name", "Subreddit", "Regex Pattern"],
                rows: tableRows,
            },
        });
    } else {
        wikiContent.push({ p: "No ReDoS vulnerabilities were detected in the evaluator regex patterns." });
    }

    await context.reddit.updateWikiPage({
        subredditName: context.subredditName ?? await context.reddit.getCurrentSubredditName(),
        page: wikiPageName,
        content: json2md(wikiContent),
        reason: "Updating ReDoS Detections Report",
    });

    await context.redis.del(REDOS_QUEUE_KEY);
    await context.redis.del(REDOS_HITS_KEY);
}
