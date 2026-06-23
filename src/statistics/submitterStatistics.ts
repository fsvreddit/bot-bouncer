import { JobContext, TriggerContext, WikiPage, WikiPagePermissionLevel } from "@devvit/public-api";
import { UserStatus } from "../dataStore.js";
import _ from "lodash";
import { subMonths } from "date-fns";
import json2md from "json2md";
import { ZMember } from "@devvit/protos";
import { getControlSubSettings } from "../settings.js";
import type { ControlSubSettings } from "../settings.js";
import { StatsUserEntry } from "../scheduler/sixHourlyJobs.js";

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

export async function updateSubmitterStatistics (allStatuses: StatsUserEntry[], context: JobContext) {
    const organicStatuses: Record<string, number> = {};
    const bannedStatuses: Record<string, number> = {};

    for (const status of allStatuses.map(entry => entry.data)) {
        if (!status.submitter || !status.reportedAt) {
            continue;
        }

        if (status.reportedAt < subMonths(new Date(), 1).getTime()) {
            continue;
        }

        if (status.userStatus === UserStatus.Organic || status.userStatus === UserStatus.Service) {
            organicStatuses[status.submitter] = (organicStatuses[status.submitter] ?? 0) + 1;
        } else if (status.userStatus === UserStatus.Banned || (status.userStatus === UserStatus.Purged && status.lastStatus === UserStatus.Banned)) {
            bannedStatuses[status.submitter] = (bannedStatuses[status.submitter] ?? 0) + 1;
        }
    }

    const distinctUsers = _.uniq([...Object.keys(organicStatuses), ...Object.keys(bannedStatuses)]);
    const submitterStatistics: SubmitterStatistic[] = [];
    const successRatesToStore: ZMember[] = [];
    const controlSubSettings = await getControlSubSettings(context);
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
