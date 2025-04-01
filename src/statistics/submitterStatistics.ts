import { JobContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { UserDetails, UserStatus } from "../dataStore.js";
import { uniq } from "lodash";

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
        if (!status.submitter) {
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

    let wikiContent = "Submitter statistics\n\n";

    for (const item of submitterStatistics.sort((a, b) => a.count - b.count)) {
        wikiContent += `* **${item.submitter}**: ${item.count} (${item.ratio}% banned)\n`;
    }

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
        content: wikiContent,
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
