import { JobContext } from "@devvit/public-api";
import { DISPLAY_NAME_STORE, UserDetails, UserStatus } from "../dataStore.js";
import { subWeeks } from "date-fns";
import { getEvaluatorVariables } from "../userEvaluation/evaluatorVariables.js";
import json2md from "json2md";

type UserDetailsWithDisplayName = UserDetails & { displayName?: string };

export async function updateDisplayNameStatistics (allEntries: [string, UserDetails][], context: JobContext) {
    let recentData = allEntries
        .map(([username, data]) => ({ username, data: data as UserDetailsWithDisplayName }))
        .filter(item => item.data.reportedAt && new Date(item.data.reportedAt) >= subWeeks(new Date(), 2));

    const displayNames = await context.redis.hMGet(DISPLAY_NAME_STORE, recentData.map(item => item.username));

    for (let i = 0; i < recentData.length; i++) {
        recentData[i].data.displayName = displayNames[i] ?? undefined;
    }

    recentData = recentData.filter(item => item.data.displayName);
    const recentBanned = recentData.filter(item => item.data.userStatus === UserStatus.Banned || item.data.lastStatus === UserStatus.Banned);

    const evaluatorVariables = await getEvaluatorVariables(context);
    const displayNameRegexes = evaluatorVariables["baddisplayname:regexes"] as string[] | undefined ?? [];

    const displayNameCounts: Record<string, number> = {};
    for (const item of recentBanned) {
        if (item.data.displayName) {
            displayNameCounts[item.data.displayName] = (displayNameCounts[item.data.displayName] ?? 0) + 1;
        }
    }

    const wikiContent: json2md.DataObject[] = [];
    wikiContent.push({ h1: "Bad Display Name Statistics" });

    const displayNameHeaders = ["Display Name", "Count", "Covered by Evaluator"];
    const displayNameRows: string[][] = [];
    for (const [displayName, count] of Object.entries(displayNameCounts).sort((a, b) => b[1] - a[1])) {
        if (count < 5) {
            continue;
        }

        const isCovered = displayNameRegexes.some(regex => new RegExp(regex, "u").test(displayName));
        displayNameRows.push([
            `\`${displayName}\``,
            count.toLocaleString(),
            isCovered ? "Yes" : "**No**",
        ]);
    }

    if (displayNameRows.length > 0) {
        wikiContent.push({ p: "This table lists all display names used at least five times on banned users in the last two weeks." });
        wikiContent.push({ table: { headers: displayNameHeaders, rows: displayNameRows } });
        wikiContent.push({ hr: {} });
    }

    const regexHeaders = ["Regex", "Count", "False Positive %", "Example Organics"];
    const regexRows: string[][] = [];

    for (const regex of displayNameRegexes) {
        const entriesMatchingRegex = recentData.filter(item => item.data.displayName && new RegExp(regex, "u").test(item.data.displayName));
        let regexForRow = regex.replace(/\|/g, "¦");

        if (regexForRow.length > 50) {
            regexForRow = `${regexForRow.slice(0, 50)}...`;
        }

        if (entriesMatchingRegex.length === 0) {
            regexRows.push([
                `\`${regexForRow}\``,
                "0",
                "",
                "",
            ]);
        } else {
            regexRows.push([
                `\`${regexForRow}\``,
                entriesMatchingRegex.length.toLocaleString(),
                `${Math.round(100 * entriesMatchingRegex.filter(item => item.data.userStatus === UserStatus.Organic || item.data.userStatus === UserStatus.Declined).length / entriesMatchingRegex.length)}%`,
                entriesMatchingRegex.filter(item => item.data.userStatus === UserStatus.Organic)
                    .slice(0, 5)
                    .map(item => `/u/${item.username}`)
                    .join(", "),
            ]);
        }
    }

    wikiContent.push({ p: "This table lists all the 'Bad Display Name' regexes and their statistics from accounts submitted in the last two weeks." });
    wikiContent.push({ table: { headers: regexHeaders, rows: regexRows } });
    wikiContent.push({ p: "Note: | characters in regexes have been replaced with ¦ characters, because Reddit's markdown table support is broken" });

    wikiContent.push({ p: "This page updates every 6 hours, and may update more frequently." });

    await context.reddit.updateWikiPage({
        subredditName: context.subredditName ?? await context.reddit.getCurrentSubredditName(),
        page: "statistics/displaynames",
        content: json2md(wikiContent),
    });
}
