import { JobContext } from "@devvit/public-api";
import { format, subWeeks } from "date-fns";
import json2md from "json2md";
import { BIO_TEXT_STORE, UserDetails, UserStatus } from "../dataStore.js";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";
import { max } from "lodash";
import { StatsUserEntry } from "../sixHourlyJobs.js";

interface BioRecord {
    lastSeen?: Date;
    hits: number;
    users?: string[];
}

function appendedArray (existing: string[], newItems: string[]): string[] {
    return Array.from(new Set([...existing, ...newItems])).filter(item => !item.startsWith("u_"));
}

type UserDetailsWithBio = UserDetails & { bio?: string };

export async function updateBioStatistics (allEntries: StatsUserEntry[], context: JobContext) {
    let recentData = allEntries
        .map(item => ({ username: item.username, data: item.data as UserDetailsWithBio }))
        .filter(item => item.data.reportedAt && new Date(item.data.reportedAt) >= subWeeks(new Date(), 2))
        .filter(item => item.data.userStatus === UserStatus.Banned || item.data.lastStatus === UserStatus.Banned);

    const userBios = await context.redis.hMGet(BIO_TEXT_STORE, recentData.map(item => item.username));

    for (let i = 0; i < recentData.length; i++) {
        const bioText = userBios[i];
        if (bioText) {
            recentData[i].data.bio = bioText;
        }
    }

    recentData = recentData.filter(item => item.data.bio);

    const evaluatorVariables = await getEvaluatorVariables(context);
    const configuredBioRegexes = evaluatorVariables["biotext:bantext"] as string[] | undefined ?? [];

    const bioRecords: Record<string, BioRecord> = {};

    for (const item of recentData) {
        if (!item.data.bio) {
            continue;
        }

        const existingRecord = bioRecords[item.data.bio];

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (existingRecord) {
            bioRecords[item.data.bio] = {
                lastSeen: item.data.reportedAt ? max([existingRecord.lastSeen, new Date(item.data.reportedAt)]) : existingRecord.lastSeen,
                hits: existingRecord.hits + 1,
                users: appendedArray(existingRecord.users ?? [], [item.username]),
            };
        } else {
            bioRecords[item.data.bio] = {
                lastSeen: item.data.reportedAt ? new Date(item.data.reportedAt) : undefined,
                hits: 1,
                users: [item.username],
            };
        }
    }

    const reusedRecords = Object.entries(bioRecords)
        .map(([bioText, record]) => ({ bioText, record }))
        .filter(record => record.record.hits > 1);

    if (reusedRecords.length === 0) {
        return;
    }

    reusedRecords.sort((a, b) => b.record.hits - a.record.hits);

    const content: json2md.DataObject[] = [];

    content.push({ h1: "User Bio Text" });
    content.push({ h2: "Bio text used by more than one user in the last two weeks" });
    for (const record of reusedRecords) {
        content.push({ blockquote: record.bioText });
        const listRows: string[] = [];
        if (!configuredBioRegexes.some(regex => new RegExp(regex, "u").exec(record.bioText))) {
            listRows.push("**Not in Evaluators**");
        }
        listRows.push(
            `Last seen: ${record.record.lastSeen ? format(record.record.lastSeen, "MMM dd") : ""}`,
            `Distinct users: ${record.record.hits}`,
        );
        if (record.record.users) {
            listRows.push(`Example users: ${record.record.users.slice(-5).map(user => `u/${user}`).join(", ")}`);
        }
        content.push({ ul: listRows });
        content.push({ hr: {} });
    }

    if (configuredBioRegexes.length > 0) {
        const bullets: string[] = [];
        for (const regex of configuredBioRegexes) {
            if (!reusedRecords.some(record => new RegExp(regex, "u").exec(record.bioText))) {
                bullets.push(`\`${regex}\``);
            }
        }

        if (bullets.length > 0) {
            content.push({ p: "The following bio regexes are in the Evaluator Configuration but have not been seen in the last two weeks:" });
            content.push({ ul: bullets });
        }
    }

    await context.reddit.updateWikiPage({
        subredditName: "botbouncer",
        page: "statistics/biotext",
        content: json2md(content),
    });
}
