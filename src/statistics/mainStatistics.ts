import { JobContext, WikiPage } from "@devvit/public-api";
import { AGGREGATE_STORE } from "../dataStore.js";
import { sum } from "lodash";

export async function updateMainStatisticsPage (context: JobContext) {
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
}
