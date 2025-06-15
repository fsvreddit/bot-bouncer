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

    const evaluatorVariables = await getEvaluatorVariables(context);
    const displayNameRegexes = evaluatorVariables["baddisplayname:regexes"] as string[] | undefined ?? [];

    const headers = ["Regex", "Count", "False Positive %", "Example Organics"];
    const rows: string[][] = [];

    for (const regex of displayNameRegexes) {
        const entriesMatchingRegex = recentData.filter(item => item.data.displayName && new RegExp(regex, "u").test(item.data.displayName));
        let regexForRow = regex.replace(/\|/g, "¦");

        if (regexForRow.length > 50) {
            regexForRow = `${regexForRow.slice(0, 50)}...`;
        }

        if (entriesMatchingRegex.length === 0) {
            rows.push([
                `\`${regexForRow}\``,
                "0",
                "",
                "",
            ]);
        } else {
            rows.push([
                `\`${regexForRow}\``,
                entriesMatchingRegex.length.toLocaleString(),
                `${Math.round(100 * entriesMatchingRegex.filter(item => item.data.userStatus === UserStatus.Organic || item.data.userStatus === UserStatus.Declined).length / entriesMatchingRegex.length)}%`,
                entriesMatchingRegex.filter(item => item.data.userStatus === UserStatus.Organic)
                    .slice(0, 5)
                    .map(item => `/u/${item.username}`)
                    .join(", "),
            ]);
        }

        const wikiContent: json2md.DataObject[] = [];
        wikiContent.push({ h1: "Bad Display Name Statistics" });
        wikiContent.push({ p: "This page lists all the 'Bad Display Name' regexes and their statistics from accounts submitted in the last two weeks." });
        wikiContent.push({ table: { headers, rows } });
        wikiContent.push({ p: "Note: | characters in regexes have been replaced with ¦ characters, because Reddit's markdown table support is broken" });
        wikiContent.push({ p: "This page updates once a day at midnight UTC, and may update more frequently." });

        await context.reddit.updateWikiPage({
            subredditName: context.subredditName ?? await context.reddit.getCurrentSubredditName(),
            page: "statistics/displaynames",
            content: json2md(wikiContent),
        });
    }
}
