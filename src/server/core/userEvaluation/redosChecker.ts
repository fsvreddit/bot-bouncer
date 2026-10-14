import { context, reddit, redis, scheduler, TaskRequest } from "@devvit/web/server";
import { getEvaluatorVariables } from ".";
import { ALL_RELEVANT_EVALUTORS, ControlSubredditJob, decodedText, encodedText, expireKeyAt, getControlSubSettings } from "..";
import { hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addMinutes, addSeconds } from "date-fns";
import { EvaluatorRegex } from "@fsvreddit/bot-bouncer-evaluation";
import { isSafe } from "redos-detector";
import json2md from "json2md";
import { RedosCheckerJobData } from "../../tasks";

const REDOS_QUEUE_KEY = "evaluatorRedosQueue";
const REDOS_HITS_KEY = "evaluatorRedosHits";

async function queueRedosCheckEntries () {
    const evaluatorVariables = await getEvaluatorVariables();
    let entriesAdded = 0;
    for (const Evaluator of ALL_RELEVANT_EVALUTORS) {
        const evaluatorInstance = new Evaluator([], undefined, evaluatorVariables);
        const evaluatorRegexes = evaluatorInstance.gatherRegexes();
        if (evaluatorRegexes.length === 0) {
            continue;
        }
        entriesAdded += await redis.zAdd(REDOS_QUEUE_KEY, ...evaluatorRegexes.map(regex => ({ member: encodedText(JSON.stringify(regex)), score: Date.now() })));
        await expireKeyAt(REDOS_QUEUE_KEY, addMinutes(new Date(), 30));
    }

    console.log(`ReDoS Checker: Queued ${entriesAdded.toLocaleString()} regex entries for checking.`);
}

export async function redosChecker (event: TaskRequest<RedosCheckerJobData | undefined>) {
    const jobGuid = event.data?.jobGuid;
    if (jobGuid && await hasTriggerBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`ReDoS Checker: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    const inProgressKey = "redosCheckerInProgress";

    if (event.data?.firstRun) {
        if (await redis.exists(inProgressKey)) {
            console.log("ReDoS Checker: Previous run still in progress, skipping this run.");
            return;
        }

        const controlSubSettings = await getControlSubSettings();
        if (!controlSubSettings.redosCheckerEnabled) {
            console.log("ReDoS Checker: ReDoS checker is disabled in control sub settings, skipping this run.");
            return;
        }

        await redis.del(REDOS_QUEUE_KEY, REDOS_HITS_KEY);

        await queueRedosCheckEntries();
        await scheduler.runJob<RedosCheckerJobData>({
            name: ControlSubredditJob.EvaluatorReDoSChecker,
            runAt: addSeconds(new Date(), 2),
            data: {
                firstRun: false,
                modName: event.data.modName,
                jobGuid: crypto.randomUUID(),
            },
        });

        return;
    }

    if (event.data?.finalise) {
        await finaliseReDosReport();
        return;
    }

    await redis.set(inProgressKey, "true", { expiration: addSeconds(new Date(), 60) });
    const batchNumber = event.data?.batchNumber ?? 1;
    const batchSize = 50;
    console.log(`ReDoS Checker: Starting batch #${batchNumber}...`);

    const runLimit = addSeconds(new Date(), 10);
    const remainingEntries = await redis.zCard(REDOS_QUEUE_KEY);
    console.log(`ReDoS Checker: ${remainingEntries.toLocaleString()} entries remaining in queue.`);

    const redosQueue = await redis.zRange(REDOS_QUEUE_KEY, 0, batchSize - 1).then(entries => entries.map(entry => entry.member));
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
            const safeResult = isSafe(regex, { maxScore: 500, timeout: 500 });
            if (!safeResult.safe) {
                await redis.zAdd(REDOS_HITS_KEY, ({ member: entry, score: Date.now() }));

                // TODO: Notify via webhook
            }
        } catch (error) {
            console.error(`ReDoS Checker: Error checking regex /${regexEntry.regex}/${regexEntry.flags ?? ""}:`, error);
        }

        processed.push(entry);
    }

    if (processed.length > 0) {
        await redis.zRem(REDOS_QUEUE_KEY, processed);
    }

    console.log(`ReDoS Checker: Processed ${processed.length} entries, ${remainingEntries - processed.length} remaining, batch #${batchNumber} complete.`);

    if (remainingEntries > processed.length) {
        await scheduler.runJob<RedosCheckerJobData>({
            name: ControlSubredditJob.EvaluatorReDoSChecker,
            runAt: addSeconds(new Date(), 2),
            data: {
                firstRun: false,
                modName: event.data?.modName ?? "unknown",
                batchNumber: batchNumber + 1,
                jobGuid: crypto.randomUUID(),
            },
        });
    } else {
        console.log("ReDoS Checker: Completed all entries.");
        await scheduler.runJob<RedosCheckerJobData>({
            name: ControlSubredditJob.EvaluatorReDoSChecker,
            runAt: addSeconds(new Date(), 5),
            data: {
                finalise: true,
                jobGuid: crypto.randomUUID(),
            },
        });
    }
}

async function finaliseReDosReport () {
    const redosHits = await redis.zRange(REDOS_HITS_KEY, 0, -1).then(entries => entries.map(entry => JSON.parse(decodedText(entry.member)) as EvaluatorRegex));

    const wikiPageName = "statistics/redos-detections";

    const wikiContent: json2md.DataObject[] = [
        { h1: "ReDoS Detections Report" },
        { p: `This report lists all regular expressions used by evaluators that have been identified as potentially vulnerable to Regular Expression Denial of Service (ReDoS) attacks. A total of ${redosHits.length.toLocaleString()} vulnerable regex patterns were detected.` },
    ];

    if (redosHits.length > 0) {
        const tableRows = redosHits.map((hit) => {
            const regex = hit.regex.length > 100 ? hit.regex.slice(0, 100) + "…" : hit.regex;
            return [
                hit.evaluatorName,
                hit.subName ?? "",
                `\`${regex.replaceAll("|", "¦")}\``,
            ];
        });

        wikiContent.push({
            table: {
                headers: ["Evaluator Name", "Subreddit", "Regex Pattern"],
                rows: tableRows,
            },
        });
    } else {
        wikiContent.push({ p: "No ReDoS vulnerabilities were detected in the evaluator regex patterns." });
    }

    await reddit.updateWikiPage({
        subredditName: context.subredditName,
        page: wikiPageName,
        content: json2md(wikiContent),
        reason: "Updating ReDoS Detections Report",
    });

    await redis.del(REDOS_QUEUE_KEY, REDOS_HITS_KEY);
}
