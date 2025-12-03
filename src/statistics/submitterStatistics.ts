import { JobContext, TriggerContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { UserDetails, UserStatus } from "../dataStore.js";
import _ from "lodash";
import { subMonths } from "date-fns";
import json2md from "json2md";
import { ZMember } from "@devvit/protos";
import { getControlSubSettings } from "../settings.js";

interface SubmitterStatistic {
    submitter: string;
    count: number;
    ratio: number;
}

const SUBMITTER_SUCCESS_RATE_KEY = "SubmitterSuccessRate";

export async function updateSubmitterStatistics (allStatuses: UserDetails[], context: JobContext) {
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

    const distinctUsers = _.uniq([...Object.keys(organicStatuses), ...Object.keys(bannedStatuses)]);
    const submitterStatistics: SubmitterStatistic[] = [];
    const successRatesToStore: ZMember[] = [];

    for (const user of distinctUsers) {
        const organicCount = organicStatuses[user] ?? 0;
        const bannedCount = bannedStatuses[user] ?? 0;
        const totalCount = organicCount + bannedCount;
        const ratio = Math.round(100 * bannedCount / totalCount);
        submitterStatistics.push({ submitter: user, count: totalCount, ratio });

        if (organicCount + bannedCount >= 5) {
            successRatesToStore.push({ member: user, score: ratio });
        }
    }

    const wikiContent: json2md.DataObject[] = [];
    wikiContent.push({ h1: "Submitter statistics" });
    wikiContent.push({ p: "This lists all users who have submitted an account for review within the last month." });

    const controlSubSettings = await getControlSubSettings(context);

    const tableRows = submitterStatistics
        .filter(item => item.count >= 5)
        .sort((a, b) => b.count - a.count)
        .map(item => [
            item.submitter,
            item.count.toLocaleString(),
            `${item.ratio}%`,
            controlSubSettings.trustedSubmitters.includes(item.submitter) || item.submitter.startsWith(context.appName) ? "Yes" : "",
        ]);

    wikiContent.push({ table: { headers: ["Submitter", "Total Accounts", "Ratio", "Trusted"], rows: tableRows } });
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

    await context.redis.del(SUBMITTER_SUCCESS_RATE_KEY);
    if (successRatesToStore.length > 0) {
        await context.redis.zAdd(SUBMITTER_SUCCESS_RATE_KEY, ...successRatesToStore);
    }
}

export async function getSubmitterSuccessRate (submitter: string, context: TriggerContext): Promise<number | undefined> {
    return await context.redis.zScore(SUBMITTER_SUCCESS_RATE_KEY, submitter);
}
