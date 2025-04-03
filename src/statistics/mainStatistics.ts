import { JobContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { AGGREGATE_STORE, UserDetails, UserStatus } from "../dataStore.js";
import { countBy, sum } from "lodash";

export async function updateMainStatisticsPage (allData: Record<string, string>, context: JobContext) {
    await correctAggregateData(allData, context);

    let results = await context.redis.zRange(AGGREGATE_STORE, 0, -1);
    results = results.filter(item => item.member !== "pending");

    let wikiContent = "# Bot Bouncer statistics\n\nThis page details the number of accounts that have been processed by Bot Bouncer.\n\n";

    for (const item of results) {
        wikiContent += `* **${item.member}**: ${item.score.toLocaleString()}\n`;
    }

    wikiContent += `\n**Total accounts processed**: ${sum(results.map(item => item.score)).toLocaleString()}\n\n`;
    wikiContent += "These statistics update once a day at midnight UTC.";

    const wikiPageName = "statistics";
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, wikiPageName);
    } catch {
        //
    }

    if (wikiContent.trim() !== wikiPage?.content.trim()) {
        await context.reddit.updateWikiPage({
            subredditName,
            page: wikiPageName,
            content: wikiContent,
        });
    }

    if (!wikiPage) {
        await context.reddit.updateWikiPageSettings({
            listed: true,
            page: wikiPageName,
            subredditName,
            permLevel: WikiPagePermissionLevel.MODS_ONLY,
        });
    }
}

async function correctAggregateData (data: Record<string, string>, context: JobContext) {
    const entries = Object.entries(data).map(([, value]) => JSON.parse(value) as UserDetails);

    const statusesToUpdate = [UserStatus.Banned, UserStatus.Pending, UserStatus.Organic, UserStatus.Service, UserStatus.Declined];
    const statuses = Object.entries(countBy(entries.map(item => item.userStatus)))
        .map(([key, value]) => ({ member: key, score: value }))
        .filter(item => statusesToUpdate.includes(item.member as UserStatus));

    await context.redis.zAdd(AGGREGATE_STORE, ...statuses);
}
