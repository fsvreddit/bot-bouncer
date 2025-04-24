import { JobContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { UserDetails, UserStatus } from "../dataStore.js";
import { uniq } from "lodash";
import { subMonths } from "date-fns";
import json2md from "json2md";

interface SubmitterStatistic {
    submitter: string;
    count: number;
    ratio: number;
}

export async function updateSubmitterStatistics (allData: Record<string, string>, context: JobContext) {
    const allStatuses = Object.values(allData).map(item => JSON.parse(item) as UserDetails);

    const organicStatuses: Record<string, number> = {};
    const bannedStatuses: Record<string, number> = {};

    for (const status of allStatuses) {
        if (!status.submitter || !status.reportedAt) {
            continue;
        }

        if (status.reportedAt < subMonths(new Date(), 1).getTime()) {
            continue;
        }

        if (status.userStatus === UserStatus.Organic || status.userStatus === UserStatus.Service || status.userStatus === UserStatus.Declined) {
            organicStatuses[status.submitter] = (organicStatuses[status.submitter] ?? 0) + 1;
        } else if (status.userStatus === UserStatus.Banned || (status.userStatus === UserStatus.Purged && status.lastStatus === UserStatus.Banned)) {
            bannedStatuses[status.submitter] = (bannedStatuses[status.submitter] ?? 0) + 1;
        }
    }

    const distinctUsers = uniq([...Object.keys(organicStatuses), ...Object.keys(bannedStatuses)]);
    const submitterStatistics: SubmitterStatistic[] = [];
    for (const user of distinctUsers) {
        const organicCount = organicStatuses[user] ?? 0;
        const bannedCount = bannedStatuses[user] ?? 0;
        const totalCount = organicCount + bannedCount;
        const ratio = Math.round(100 * bannedCount / totalCount);
        submitterStatistics.push({ submitter: user, count: totalCount, ratio });
    }

    const wikiContent: json2md.DataObject[] = [];
    wikiContent.push({ h1: "Submitter statistics" });
    wikiContent.push({ p: "This lists all users who have submitted an account for review within the last month." });

    const tableRows = submitterStatistics
        .sort((a, b) => b.count - a.count)
        .map(item => [item.submitter, item.count.toLocaleString(), `${item.ratio}%`]);

    wikiContent.push({ table: { headers: ["Submitter", "Total Accounts", "Ratio"], rows: tableRows } });
    wikiContent.push({ p: "This page updates once a day at midnight UTC, and may update more frequently." });

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();
    let wikiPage: WikiPage | undefined;
    const submitterStatisticsWikiPage = "statistics/submitters";
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, submitterStatisticsWikiPage);
    } catch {
        //
    }

    await context.reddit.updateWikiPage({
        subredditName,
        page: submitterStatisticsWikiPage,
        content: json2md(wikiContent),
    });

    if (!wikiPage) {
        await context.reddit.updateWikiPageSettings({
            listed: true,
            page: submitterStatisticsWikiPage,
            subredditName,
            permLevel: WikiPagePermissionLevel.MODS_ONLY,
        });
    }
}
