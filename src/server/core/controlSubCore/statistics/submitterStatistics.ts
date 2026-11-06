import { context, reddit, redis, scheduler, WikiPage, ZMember } from "@devvit/web/server";
import { ControlSubSettings, UserStatus } from "@fsvreddit/bot-bouncer-types";
import { StatsUserEntry } from "./statsHelpers";
import { addHours, subMonths } from "date-fns";
import { accountIsBotBouncerApp, ControlSubredditJob, expireKeyAt, getControlSubSettings, getFullDataStore, UserDetails, UserFlag } from "../..";
import json2md from "json2md";
import { uniq } from "lodash-es";
import { UpdateSubmitterSuccessRateJobData } from "../../../tasks";

export interface SubmitterStatistic {
    submitter: string;
    count: number;
    ratio: number;
}

const SUBMITTER_SUCCESS_RATE_KEY = "SubmitterSuccessRate";
const DEFAULT_THRESHOLD_FOR_SUBMITTER_CALCULATION = 10;
const BULK_RECOMMENDATION_MINIMUM_COUNT = 25;
const BULK_RECOMMENDATION_MINIMUM_RATIO = 85;
const TRUSTED_RECOMMENDATION_MINIMUM_COUNT = 100;
const TRUSTED_RECOMMENDATION_MINIMUM_RATIO = 90;

type SubmitterStatusCell = "**Yes**" | "Auto" | "Recommended" | "";

function usernameIsInList (username: string, list: string[] | undefined): boolean {
    return list?.some(item => item.toLowerCase() === username.toLowerCase()) ?? false;
}

export function submitterMeetsBulkRecommendationCriteria (item: SubmitterStatistic): boolean {
    return item.count >= BULK_RECOMMENDATION_MINIMUM_COUNT && item.ratio >= BULK_RECOMMENDATION_MINIMUM_RATIO;
}

export function submitterMeetsTrustedRecommendationCriteria (item: SubmitterStatistic, minimumRatio = TRUSTED_RECOMMENDATION_MINIMUM_RATIO): boolean {
    return item.count >= TRUSTED_RECOMMENDATION_MINIMUM_COUNT && item.ratio >= minimumRatio;
}

export function submitterNeedsGuidance (item: SubmitterStatistic): boolean {
    const reversalRate = 100 - item.ratio;
    const estimatedReversals = item.count * reversalRate / 100;

    return (estimatedReversals >= 20 && reversalRate >= 20) || (estimatedReversals >= 50 && reversalRate >= 5);
}

function submitterHasTrustedStatus (submitter: string, controlSubSettings: ControlSubSettings, appSlug: string): boolean {
    return usernameIsInList(submitter, controlSubSettings.trustedSubmitters) || submitter.toLowerCase().startsWith(appSlug.toLowerCase());
}

function submitterHasBulkStatus (submitter: string, controlSubSettings: ControlSubSettings, appSlug: string): boolean {
    return usernameIsInList(submitter, controlSubSettings.bulkSubmitters) || submitterHasTrustedStatus(submitter, controlSubSettings, appSlug);
}

export function getSubmitterStatusCells (item: SubmitterStatistic, controlSubSettings: ControlSubSettings, appSlug: string): [SubmitterStatusCell, SubmitterStatusCell, SubmitterStatusCell] {
    const isTrustedSubmitter = submitterHasTrustedStatus(item.submitter, controlSubSettings, appSlug);
    const isBulkSubmitter = submitterHasBulkStatus(item.submitter, controlSubSettings, appSlug);
    const isExistingSubmitter = isBulkSubmitter || isTrustedSubmitter;
    const isTrustedRecommendationExcluded = usernameIsInList(item.submitter, controlSubSettings.trustedSubmitterAutoExcludedUsers);
    const trustedRecommendationMinimumRatio = Math.max(controlSubSettings.trustedSubmitterAutoThreshold ?? TRUSTED_RECOMMENDATION_MINIMUM_RATIO, TRUSTED_RECOMMENDATION_MINIMUM_RATIO);

    let bulkCell: SubmitterStatusCell = "";
    if (isBulkSubmitter) {
        bulkCell = "**Yes**";
    } else if (submitterMeetsBulkRecommendationCriteria(item)) {
        bulkCell = "Recommended";
    }

    let trustedCell: SubmitterStatusCell = "";
    if (isTrustedSubmitter) {
        trustedCell = "**Yes**";
    } else if (controlSubSettings.trustedSubmitterAutoThreshold && item.ratio > controlSubSettings.trustedSubmitterAutoThreshold && !isTrustedRecommendationExcluded) {
        trustedCell = "Auto";
    } else if (!isExistingSubmitter && !isTrustedRecommendationExcluded && submitterMeetsTrustedRecommendationCriteria(item, trustedRecommendationMinimumRatio)) {
        trustedCell = "Recommended";
    }

    const needsGuidanceCell = submitterNeedsGuidance(item) ? "**Yes**" : "";

    return [bulkCell, trustedCell, needsGuidanceCell];
}

function statusType (userDetails: UserDetails): "organic" | "banned" | undefined {
    if ((userDetails.userStatus === UserStatus.Organic || userDetails.userStatus === UserStatus.Service) && !userDetails.flags?.includes(UserFlag.HackedAndRecovered)) {
        return "organic";
    } else if (userDetails.userStatus === UserStatus.Banned || (userDetails.userStatus === UserStatus.Purged && userDetails.lastStatus === UserStatus.Banned)) {
        return "banned";
    }
}

export async function updateSubmitterStatistics (allStatuses: StatsUserEntry[]) {
    const organicStatuses: Record<string, number> = {};
    const bannedStatuses: Record<string, number> = {};

    for (const status of allStatuses.map(entry => entry.data)) {
        if (!status.submitter || !status.reportedAt) {
            continue;
        }

        if (status.reportedAt < subMonths(new Date(), 1).getTime()) {
            continue;
        }

        const type = statusType(status);
        if (type === "organic") {
            organicStatuses[status.submitter] = (organicStatuses[status.submitter] ?? 0) + 1;
        } else if (type === "banned") {
            bannedStatuses[status.submitter] = (bannedStatuses[status.submitter] ?? 0) + 1;
        }
    }

    const distinctUsers = uniq([...Object.keys(organicStatuses), ...Object.keys(bannedStatuses)]);
    const submitterStatistics: SubmitterStatistic[] = [];
    const successRatesToStore: ZMember[] = [];
    const controlSubSettings = await getControlSubSettings();
    const thresholdForSubmitterCalculation = controlSubSettings.thresholdForSubmitterCalculation ?? DEFAULT_THRESHOLD_FOR_SUBMITTER_CALCULATION;

    for (const user of distinctUsers) {
        const organicCount = organicStatuses[user] ?? 0;
        const bannedCount = bannedStatuses[user] ?? 0;
        const totalCount = organicCount + bannedCount;
        const ratio = Math.round(100 * bannedCount / totalCount);
        submitterStatistics.push({ submitter: user, count: totalCount, ratio });

        if (organicCount + bannedCount >= thresholdForSubmitterCalculation) {
            successRatesToStore.push({ member: user, score: ratio });
        }
    }

    const wikiContent: json2md.DataObject[] = [];
    wikiContent.push({ h1: "Submitter statistics" });
    wikiContent.push({ p: "This lists all users who have submitted an account for review within the last month." });

    const tableRows = submitterStatistics
        .filter(item => item.count >= thresholdForSubmitterCalculation)
        .sort((a, b) => b.count - a.count)
        .map(item => [
            item.submitter,
            item.count.toLocaleString(),
            `${item.ratio}%`,
            ...getSubmitterStatusCells(item, controlSubSettings, context.appSlug),
        ]);

    wikiContent.push({ table: { headers: ["Submitter", "Total Accounts", "Ratio", "Bulk", "Trusted", "Needs Guidance"], rows: tableRows } });
    wikiContent.push({ p: "This page updates once a day at midnight UTC, and may update more frequently." });

    let wikiPage: WikiPage | undefined;
    const submitterStatisticsWikiPage = "statistics/submitters";
    try {
        wikiPage = await reddit.getWikiPage(context.subredditName, submitterStatisticsWikiPage, {});
    } catch {
        //
    }

    await reddit.updateWikiPage({
        subredditName: context.subredditName,
        page: submitterStatisticsWikiPage,
        content: json2md(wikiContent),
    });

    if (!wikiPage) {
        await reddit.updateWikiPageSettings({
            listed: true,
            page: submitterStatisticsWikiPage,
            subredditName: context.subredditName,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment
            permLevel: 2, // MODS_ONLY
        });
    }

    await redis.del(SUBMITTER_SUCCESS_RATE_KEY);
    if (successRatesToStore.length > 0) {
        await redis.zAdd(SUBMITTER_SUCCESS_RATE_KEY, ...successRatesToStore);
    }
}

export async function getSubmitterSuccessRate (submitter: string): Promise<number | undefined> {
    const score = await redis.zScore(SUBMITTER_SUCCESS_RATE_KEY, submitter);
    if (score) {
        return Math.round(score);
    }
}

export async function queueSubmitterForSuccessRateUpdate (submitter: string) {
    const redisKey = `submitterSuccessRateUpdate:${submitter}`;
    const newValue = await redis.incrBy(redisKey, 1);
    if (newValue === 1) {
        await expireKeyAt(redisKey, addHours(new Date(), 6));
    }

    if (newValue >= 5) {
        await redis.del(redisKey);

        await scheduler.runJob<UpdateSubmitterSuccessRateJobData>({
            name: ControlSubredditJob.UpdateSubmitterSuccessRate,
            runAt: new Date(),
            data: {
                jobGuid: crypto.randomUUID(),
                username: submitter,
            },
        });
    }
}

export async function updateSubmitterSuccessRate (submitter: string) {
    if (await accountIsBotBouncerApp(submitter)) {
        return;
    }

    const data = await getFullDataStore({
        submitter: [submitter],
        since: subMonths(new Date(), 1),
        omitFlags: [UserFlag.HackedAndRecovered],
    });

    let organicCount = 0;
    let bannedCount = 0;

    for (const entry of Object.values(data)) {
        const type = statusType(entry);
        if (type === "organic") {
            organicCount++;
        } else if (type === "banned") {
            bannedCount++;
        }
    }

    const controlSubSettings = await getControlSubSettings();
    const thresholdForSubmitterCalculation = controlSubSettings.thresholdForSubmitterCalculation ?? DEFAULT_THRESHOLD_FOR_SUBMITTER_CALCULATION;

    if (organicCount + bannedCount < thresholdForSubmitterCalculation) {
        await redis.zRem(SUBMITTER_SUCCESS_RATE_KEY, [submitter]);
        return;
    }

    const ratio = organicCount + bannedCount > 0 ? (bannedCount / (organicCount + bannedCount)) * 100 : 0;

    await redis.zAdd(SUBMITTER_SUCCESS_RATE_KEY, { member: submitter, score: Math.round(ratio) });
    console.log(`Submitters: ${submitter}, now has success rate: ${ratio.toFixed(2)}%`);
}
