import { JobContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { UserDetails } from "../dataStore.js";
import { eachDayOfInterval, endOfDay, format, isSameDay, startOfDay, subDays } from "date-fns";
import { MarkdownEntry, tsMarkdown } from "ts-markdown";

export async function createTimeOfSubmissionStatistics (allEntries: UserDetails[], context: JobContext) {
    const endRange = startOfDay(new Date());
    const startRange = subDays(endRange, 28);

    const allDates = allEntries
        .map(item => item.reportedAt)
        .filter(date => date && new Date(date) >= startRange && new Date(date) < endRange)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        .map(date => new Date(date!));

    const days = eachDayOfInterval({ start: startRange, end: endOfDay(subDays(endRange, 1)) });

    const wikiContent: MarkdownEntry[] = [];
    wikiContent.push({ h1: "Time of submission statistics" });
    wikiContent.push({ p: "Here are the statistics for new submissions covering the last four weeks." });

    const dayTableRows = days.reverse()
        .map((day) => {
            const submissionInDay = allDates.filter(date => isSameDay(day, date)).length;
            return [format(day, "yyyy-MM-dd (EEEE)"), submissionInDay.toLocaleString()];
        });
    wikiContent.push({ table: { headers: ["Date", "Number of submissions"], rows: dayTableRows } });

    wikiContent.push({ p: "## Time of day statistics" });

    const timeOfDayRows = Array.from({ length: 24 }, (_, hour) => {
        const submissionInHour = allDates.filter(date => date.getHours() === hour).length;
        return [hour.toString(), submissionInHour.toLocaleString()];
    });

    wikiContent.push({ table: { headers: ["Time", "Number of submissions"], rows: timeOfDayRows } });

    wikiContent.push({ p: "This page updates once a day at midnight UTC, and may update more frequently." });

    const pageName = "statistics/time-of-submission";

    let wikiPage: WikiPage | undefined;
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, pageName);
    } catch {
        // Ignore error
    }

    await context.reddit.updateWikiPage({
        subredditName,
        page: pageName,
        content: tsMarkdown(wikiContent),
    });

    if (!wikiPage) {
        await context.reddit.updateWikiPageSettings({
            listed: true,
            page: pageName,
            subredditName,
            permLevel: WikiPagePermissionLevel.MODS_ONLY,
        });
    }
}
