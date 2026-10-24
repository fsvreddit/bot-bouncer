import { context, reddit, redis, TaskRequest, WikiPage } from "@devvit/web/server";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addMinutes } from "date-fns";
import { AGGREGATE_STORE } from "../..";
import json2md from "json2md";
import { UpdateMainStatisticsPageJobData } from "../../../tasks";
import { sum } from "lodash-es";

export async function updateMainStatisticsPage (event: TaskRequest<UpdateMainStatisticsPageJobData | undefined>) {
    // TODO: Safe, performant implementation of correctAggregateStore
    // await correctAggregateData(entries, context);

    const jobGuid = event.data?.jobGuid;
    if (jobGuid && await hasEventBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Update Main Statistics Page: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    let results = await redis.zRange(AGGREGATE_STORE, 0, -1);
    results = results.filter(item => item.member !== "pending");

    const wikiContent: json2md.DataObject[] = [];
    wikiContent.push({ h1: "Bot Bouncer statistics" });
    wikiContent.push({ p: "This page details the number of accounts that have been processed by Bot Bouncer." });

    wikiContent.push({ ul: results.map(item => `**${item.member}**: ${item.score.toLocaleString()}`) });

    wikiContent.push({ p: `**Total accounts processed**: ${sum(results.map(item => item.score)).toLocaleString()}` });
    wikiContent.push({ p: "These statistics update every 6 hours, and may update more frequently." });

    const wikiPageName = "statistics";
    const subredditName = context.subredditName;

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await reddit.getWikiPage(subredditName, wikiPageName, {});
    } catch {
        //
    }

    const content = json2md(wikiContent);

    if (content.trim() !== wikiPage?.content.trim()) {
        await reddit.updateWikiPage({
            subredditName,
            page: wikiPageName,
            content,
        });
    }

    if (!wikiPage) {
        await reddit.updateWikiPageSettings({
            listed: true,
            page: wikiPageName,
            subredditName,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
            permLevel: 2, // MODS_ONLY
        });
    }
}
