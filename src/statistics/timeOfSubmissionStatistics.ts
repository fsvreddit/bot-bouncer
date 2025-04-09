import { JobContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { UserDetails } from "../dataStore.js";
import { eachDayOfInterval, endOfDay, format, isSameDay, startOfDay, subDays } from "date-fns";

export async function createTimeOfSubmissionStatistics (allData: Record<string, string>, context: JobContext) {
    const endRange = startOfDay(new Date());
    const startRange = subDays(endRange, 28);

    const allDates = Object.values(allData)
        .map(item => JSON.parse(item) as UserDetails)
        .map(item => item.reportedAt)
        .filter(date => date && new Date(date) >= startRange && new Date(date) < endRange)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        .map(date => new Date(date!));

    const days = eachDayOfInterval({ start: startRange, end: endOfDay(subDays(endRange, 1)) });

    let content = "Here are the statistics for new submissions covering the last four weeks.\n\n";
    content += "| Date | Number of submissions |\n";
    content += "|:-|:-|\n";
    for (const day of days) {
        const submissionInDay = allDates.filter(date => isSameDay(day, date)).length;
        content += `| ${format(day, "yyyy-MM-dd (EEEE)")} | ${submissionInDay} |\n`;
    }

    content += "## Time of day statistics\n\n";

    content += "| Time | Number of submissions |\n";
    content += "|:-|:-|\n";

    for (let hour = 0; hour < 24; hour++) {
        const submissionInHour = allDates.filter(date => date.getHours() === hour).length;
        content += `| ${hour} | ${submissionInHour} |\n`;
    }

    content += "\n\nThis page updates once a day at midnight UTC.\n\n";

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
        content,
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
