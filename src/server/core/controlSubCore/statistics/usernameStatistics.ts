import { context, reddit } from "@devvit/web/server";
import { subWeeks } from "date-fns";
import { StatsUserEntry } from "./statsHelpers";
import { getEvaluatorVariable } from "../../userEvaluation";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import json2md from "json2md";

export async function updateUsernameStatistics (allEntries: StatsUserEntry[]) {
    const recentData = allEntries
        .filter(item => item.data.reportedAt && new Date(item.data.reportedAt) >= subWeeks(new Date(), 2));

    const columns = ["Regex", "Count", "False Positive %", "Example Organics"];
    const rows: string[][] = [];

    const regexes = await getEvaluatorVariable<string[]>("badusername:regexes") ?? [];

    for (const regex of regexes) {
        const entriesMatchingRegex = recentData.filter(item => new RegExp(regex).test(item.username));
        let regexForRow = regex.replaceAll("|", "¦");

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
                `${Math.round(100 * entriesMatchingRegex.filter(item => item.data.userStatus === UserStatus.Organic).length / entriesMatchingRegex.length)}%`,
                entriesMatchingRegex.filter(item => item.data.userStatus === UserStatus.Organic)
                    .slice(0, 5)
                    .map(item => `/u/${item.username}`)
                    .join(", "),
            ]);
        }
    }

    const wikiContent: json2md.DataObject[] = [];
    wikiContent.push({ h1: "Username Statistics" });
    wikiContent.push({ p: "This page lists all the 'Bad Username' regexes and their statistics from accounts submitted in the last two weeks." });
    wikiContent.push({ table: { headers: columns, rows } });

    wikiContent.push({ p: "Note: | characters in regexes have been replaced with ¦ characters, because Reddit's markdown table support is broken" });

    wikiContent.push({ p: "This page updates once a day at midnight UTC, and may update more frequently." });

    await reddit.updateWikiPage({
        subredditName: context.subredditName,
        page: "statistics/badusernames",
        content: json2md(wikiContent),
    });
}
