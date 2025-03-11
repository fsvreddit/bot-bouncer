import { JobContext, TriggerContext, WikiPagePermissionLevel, WikiPage, ScheduledJobEvent, JSONObject } from "@devvit/public-api";
import { compact, countBy, Dictionary, max, sum, toPairs, uniq } from "lodash";
import pako from "pako";
import { scheduleAdhocCleanup, setCleanupForSubmittersAndMods, setCleanupForUsers } from "./cleanup.js";
import { CONTROL_SUBREDDIT, HANDLE_CLASSIFICATION_CHANGES_JOB } from "./constants.js";
import { addSeconds, addWeeks, startOfSecond, subDays, subHours } from "date-fns";
import pluralize from "pluralize";
import { getControlSubSettings } from "./settings.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";

const USER_STORE = "UserStore";
const POST_STORE = "PostStore";
const AGGREGATE_STORE = "AggregateStore";
const WIKI_UPDATE_DUE = "WikiUpdateDue";
const WIKI_PAGE = "botbouncer";
const MAX_WIKI_PAGE_SIZE = 524288;

export enum UserStatus {
    Pending = "pending",
    Banned = "banned",
    Service = "service",
    Organic = "organic",
    Purged = "purged",
    Retired = "retired",
    Declined = "declined",
    Inactive = "inactive",
}

export interface UserDetails {
    trackingPostId: string;
    userStatus: UserStatus;
    lastStatus?: UserStatus;
    lastUpdate: number;
    submitter?: string;
    operator: string;
}

export async function getUserStatus (username: string, context: TriggerContext) {
    const value = await context.redis.hGet(USER_STORE, username);
    if (!value) {
        return;
    }

    return JSON.parse(value) as UserDetails;
}

export async function setUserStatus (username: string, details: UserDetails, context: TriggerContext) {
    if (!isLinkId(details.trackingPostId) && !isCommentId(details.trackingPostId)) {
        throw new Error(`Tracking post ID is missing or invalid for ${username}: ${details.trackingPostId}!`);
    }

    const currentStatus = await getUserStatus(username, context);

    if (currentStatus?.userStatus === UserStatus.Banned || currentStatus?.userStatus === UserStatus.Service || currentStatus?.userStatus === UserStatus.Organic) {
        details.lastStatus = currentStatus.userStatus;
    }

    const promises: Promise<unknown>[] = [
        context.redis.hSet(USER_STORE, { [username]: JSON.stringify(details) }),
        context.redis.hSet(POST_STORE, { [details.trackingPostId]: username }),
    ];

    if (details.userStatus !== UserStatus.Purged && details.userStatus !== UserStatus.Retired) {
        promises.push(queueWikiUpdate(context));
    }

    if (details.userStatus === UserStatus.Pending) {
        promises.push(setCleanupForUsers([username], context, true, 1));
    } else {
        promises.push(setCleanupForUsers([username], context, true));
    }

    const submittersAndMods = uniq(compact([details.submitter, details.operator]));
    promises.push(setCleanupForSubmittersAndMods(submittersAndMods, context));

    if (details.userStatus !== currentStatus?.userStatus) {
        promises.push(updateAggregate(details.userStatus, 1, context));
        if (currentStatus) {
            promises.push(updateAggregate(currentStatus.userStatus, -1, context));
        }
    }

    await Promise.all(promises);
    await scheduleAdhocCleanup(context);
}

export async function deleteUserStatus (usernames: string[], context: TriggerContext) {
    const currentStatuses = await Promise.all(usernames.map(username => getUserStatus(username, context)));

    const promises = [
        context.redis.hDel(USER_STORE, usernames),
    ];

    const postsToDeleteTrackingFor = compact(currentStatuses.map(item => item?.trackingPostId));
    if (postsToDeleteTrackingFor.length > 0) {
        promises.push(context.redis.hDel(POST_STORE, postsToDeleteTrackingFor));
    }

    await Promise.all(promises);
}

export async function getUsernameFromPostId (postId: string, context: TriggerContext): Promise<string | undefined> {
    const username = await context.redis.hGet(POST_STORE, postId);
    return username;
}

export async function updateAggregate (type: UserStatus, incrBy: number, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        const newScore = await context.redis.zIncrBy(AGGREGATE_STORE, type, incrBy);
        console.log(`Aggregate for ${type} ${incrBy > 0 ? "increased" : "decreased"} to ${newScore}`);
    }
}

export async function correctAggregateData (context: TriggerContext) {
    const data = await context.redis.hGetAll(USER_STORE);
    const entries = Object.entries(data).map(([, value]) => JSON.parse(value) as UserDetails);

    const statusesToUpdate = [UserStatus.Banned, UserStatus.Pending, UserStatus.Organic, UserStatus.Service, UserStatus.Declined];
    const statuses = Object.entries(countBy(entries.map(item => item.userStatus)))
        .map(([key, value]) => ({ member: key, score: value }))
        .filter(item => statusesToUpdate.includes(item.member as UserStatus));

    await context.redis.zAdd(AGGREGATE_STORE, ...statuses);
}

interface SubmitterStatistic {
    submitter: string;
    count: number;
    ratio: number;
}

export async function writeAggregateToWikiPage (_: unknown, context: JobContext) {
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

    const wikiPageSaveOptions = {
        subredditName,
        page: wikiPageName,
        content: wikiContent,
    };

    if (wikiPage) {
        if (wikiContent.trim() !== wikiPage.content.trim()) {
            await context.reddit.updateWikiPage(wikiPageSaveOptions);
        }
    } else {
        await context.reddit.createWikiPage(wikiPageSaveOptions);
        await context.reddit.updateWikiPageSettings({
            subredditName,
            page: wikiPageName,
            listed: true,
            permLevel: WikiPagePermissionLevel.SUBREDDIT_PERMISSIONS,
        });
    }

    const allData = await context.redis.hGetAll(USER_STORE);
    const allStatuses = Object.values(allData).map(item => JSON.parse(item) as UserDetails);

    const organicStatuses: Dictionary<number> = {};
    const bannedStatuses: Dictionary<number> = {};

    for (const status of allStatuses) {
        if (!status.submitter) {
            continue;
        }

        if (status.userStatus === UserStatus.Organic) {
            organicStatuses[status.submitter] = (organicStatuses[status.submitter] ?? 0) + 1;
        } else if (status.userStatus === UserStatus.Banned) {
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

    wikiContent = "Submitter statistics\n\n";

    for (const item of submitterStatistics.sort((a, b) => a.count - b.count)) {
        wikiContent += `* **${item.submitter}**: ${item.count} (${item.ratio}% banned)\n`;
    }

    const submitterStatisticsWikiPage = "submitter-statistics";
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, submitterStatisticsWikiPage);
    } catch {
        wikiPage = undefined;
    }

    const submitterStatisticsWikiPageSaveOptions = {
        subredditName,
        page: submitterStatisticsWikiPage,
        content: wikiContent,
    };

    if (wikiPage) {
        await context.reddit.updateWikiPage(submitterStatisticsWikiPageSaveOptions);
    } else {
        await context.reddit.createWikiPage(submitterStatisticsWikiPageSaveOptions);
        await context.reddit.updateWikiPageSettings({
            listed: true,
            page: submitterStatisticsWikiPage,
            subredditName,
            permLevel: WikiPagePermissionLevel.MODS_ONLY,
        });
    }
}

async function queueWikiUpdate (context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    await context.redis.set(WIKI_UPDATE_DUE, "true");
}

function compressData (value: Record<string, string>): string {
    return Buffer.from(pako.deflate(JSON.stringify(value), { level: 9 })).toString("base64");
}

function compactDataForWiki (input: string): string {
    const status = JSON.parse(input) as UserDetails;
    status.operator = "";
    delete status.submitter;
    if (status.userStatus === UserStatus.Purged && status.lastStatus) {
        status.userStatus = status.lastStatus;
    }
    delete status.lastStatus;
    if (status.lastUpdate < subDays(new Date(), 2).getTime()) {
        status.lastUpdate = 0;
    } else {
        status.lastUpdate = addSeconds(startOfSecond(new Date(status.lastUpdate)), 1).getTime();
    }
    return JSON.stringify(status);
}

export async function updateWikiPage (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const forceUpdate = event.data?.force as boolean | undefined ?? false;
    const updateDue = await context.redis.get(WIKI_UPDATE_DUE);
    if (!updateDue && !forceUpdate) {
        return;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, WIKI_PAGE);
    } catch {
        //
    }

    if (wikiPage?.revisionDate && wikiPage.revisionDate > subDays(new Date(), 1) && forceUpdate) {
        // No need to run the monthly forced update, the page has been updated recently.
        return;
    }

    const data = await context.redis.hGetAll(USER_STORE);
    const entries = Object.entries(data);
    if (entries.length === 0) {
        return;
    }

    for (const entry of entries) {
        const [username, jsonData] = entry;
        data[username] = compactDataForWiki(jsonData);
    }

    const content = compressData(data);
    if (content === wikiPage?.content) {
        return;
    }

    const wikiUpdateOptions = {
        subredditName,
        content,
        page: WIKI_PAGE,
    };

    if (wikiPage) {
        await context.reddit.updateWikiPage(wikiUpdateOptions);
    } else {
        await context.reddit.createWikiPage(wikiUpdateOptions);
        await context.reddit.updateWikiPageSettings({
            subredditName,
            listed: true,
            page: WIKI_PAGE,
            permLevel: WikiPagePermissionLevel.MODS_ONLY,
        });
    }

    await context.redis.del(WIKI_UPDATE_DUE);

    console.log(`Wiki page has been updated with ${entries.length} entries`);

    if (content.length > MAX_WIKI_PAGE_SIZE * 0.5) {
        const spaceAlertKey = "wikiSpaceAlert";
        const alertDone = await context.redis.get(spaceAlertKey);
        if (!alertDone) {
            const message = `The botbouncer wiki page is now at ${Math.round(content.length / MAX_WIKI_PAGE_SIZE * 100)}% of its maximum size. It's time to rethink how data is stored.\n\nI will modmail you again in a week.`;
            await context.reddit.modMail.createModInboxConversation({
                subject: "r/BotBouncer wiki page size alert",
                bodyMarkdown: message,
                subredditId: context.subredditId,
            });
            await context.redis.set(spaceAlertKey, new Date().getTime().toString(), { expiration: addWeeks(new Date(), 1) });
        }
    }
}

function decompressData (blob: string): Record<string, string> {
    const json = Buffer.from(pako.inflate(Buffer.from(blob, "base64"))).toString();
    return JSON.parse(json) as Record<string, string>;
}

export async function updateLocalStoreFromWiki (_: unknown, context: JobContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        return;
    }

    const lastUpdateKey = "lastUpdateFromWiki";
    const lastUpdateDateKey = "lastUpdateDateKey";

    const lastUpdateDateValue = await context.redis.get(lastUpdateDateKey);
    const lastUpdateDate = lastUpdateDateValue ? new Date(parseInt(lastUpdateDateValue)) : subHours(new Date(), 6);

    let wikiContent: string;

    let wikiPage: WikiPage;
    try {
        wikiPage = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, WIKI_PAGE);
        wikiContent = wikiPage.content;
    } catch {
        console.error("Wiki Update: Failed to read wiki page from control subreddit");
        return;
    }

    const lastUpdate = await context.redis.get(lastUpdateKey);
    if (lastUpdate === wikiPage.revisionId) {
        return;
    }

    const controlSubSettings = await getControlSubSettings(context);
    const numberOfPages = controlSubSettings.numberOfWikiPages ?? 1;
    if (numberOfPages > 1) {
        for (let i = 2; i <= numberOfPages; i++) {
            try {
                const page = await context.reddit.getWikiPage(CONTROL_SUBREDDIT, `${WIKI_PAGE}/${i}`);
                wikiContent += page.content;
            } catch {
                console.error(`Wiki Update: Failed to read wiki page ${i} from control subreddit. Page may not yet exist.`);
                break;
            }
        }
    }

    const incomingData = decompressData(wikiContent);
    await context.redis.del(USER_STORE);

    if (Object.keys(incomingData).length === 0) {
        console.log("Wiki Update: Control subreddit wiki page is empty");
        return;
    }

    const usersAdded = await context.redis.hSet(USER_STORE, incomingData);

    console.log(`Wiki Update: Records for ${usersAdded} ${pluralize("user", usersAdded)} have been added`);

    const usersWithStatus = toPairs(incomingData)
        .map(([username, userdata]) => ({ username, data: JSON.parse(userdata) as UserDetails }))
        .filter(item => new Date(item.data.lastUpdate) > lastUpdateDate);

    if (usersWithStatus.length > 0) {
        const newUpdateDate = max(usersWithStatus.map(item => item.data.lastUpdate)) ?? new Date().getTime();

        const recentItems = usersWithStatus.filter(item => new Date(item.data.lastUpdate) > lastUpdateDate);

        const unbannedUsers = recentItems
            .filter(item => item.data.userStatus === UserStatus.Organic || item.data.userStatus === UserStatus.Service || item.data.userStatus === UserStatus.Declined)
            .map(item => item.username);

        const bannedUsers = recentItems
            .filter(item => item.data.userStatus === UserStatus.Banned)
            .map(item => item.username);

        if (bannedUsers.length > 0 || unbannedUsers.length > 0) {
            await context.scheduler.runJob({
                name: HANDLE_CLASSIFICATION_CHANGES_JOB,
                runAt: new Date(),
                data: { bannedUsers, unbannedUsers },
            });
            const count = bannedUsers.length + unbannedUsers.length;
            console.log(`Wiki Update: ${count} ${pluralize("user", count)} ${pluralize("has", count)} been reclassified. Job scheduled to update local store.`);
        }

        await context.redis.set(lastUpdateDateKey, newUpdateDate.toString());
    } else {
        console.log("Wiki Update: Finished processing.");
    }

    await context.redis.set(lastUpdateKey, wikiPage.revisionId);
}

export async function removeRecordOfSubmitterOrMod (username: string, context: TriggerContext) {
    const data = await context.redis.hGetAll(USER_STORE);
    const entries = Object.entries(data).map(([key, value]) => ({ username: key, details: JSON.parse(value) as UserDetails }));

    for (const entry of entries.filter(item => item.details.operator === username || item.details.submitter === username)) {
        const updatedDetails = { ...entry.details };
        if (updatedDetails.operator === username) {
            updatedDetails.operator = "";
        }
        if (updatedDetails.submitter === username) {
            delete updatedDetails.submitter;
        }

        await setUserStatus(entry.username, updatedDetails, context);
    }

    console.log(`Cleanup: Removed records of ${username} as submitter or operator`);
}
