import { JobContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { AGGREGATE_STORE, UserDetails, UserStatus } from "../dataStore.js";
import { countBy, sum } from "lodash";
import json2md from "json2md";

export async function updateMainStatisticsPage (entries: UserDetails[], context: JobContext) {
    await correctAggregateData(entries, context);

    let results = await context.redis.zRange(AGGREGATE_STORE, 0, -1);
    results = results.filter(item => item.member !== "pending");

    const wikiContent: json2md.DataObject[] = [];
    wikiContent.push({ h1: "Bot Bouncer statistics" });
    wikiContent.push({ p: "This page details the number of accounts that have been processed by Bot Bouncer." });

    wikiContent.push({ ul: results.map(item => `**${item.member}**: ${item.score.toLocaleString()}`) });

    wikiContent.push({ p: `**Total accounts processed**: ${sum(results.map(item => item.score)).toLocaleString()}` });
    wikiContent.push({ p: "These statistics update once a day at midnight UTC, and may update more frequently." });

    const wikiPageName = "statistics";
    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, wikiPageName);
    } catch {
        //
    }

    const content = json2md(wikiContent);

    if (content.trim() !== wikiPage?.content.trim()) {
        await context.reddit.updateWikiPage({
            subredditName,
            page: wikiPageName,
            content,
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

async function correctAggregateData (entries: UserDetails[], context: JobContext) {
    const statusesToUpdate = [UserStatus.Banned, UserStatus.Pending, UserStatus.Organic, UserStatus.Service, UserStatus.Declined];
    const statuses = Object.entries(countBy(entries.map(item => item.userStatus)))
        .map(([key, value]) => ({ member: key, score: value }))
        .filter(item => statusesToUpdate.includes(item.member as UserStatus));

    await context.redis.zAdd(AGGREGATE_STORE, ...statuses);
}
