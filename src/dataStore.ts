import { JobContext, TriggerContext, CreateModNoteOptions, UserSocialLink, TxClientLike, RedisClient } from "@devvit/public-api";
import { compact, fromPairs, uniq } from "lodash";
import pako from "pako";
import { setCleanupForSubmittersAndMods, setCleanupForUser } from "./cleanup.js";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { addHours, addMinutes, addSeconds, addWeeks, startOfSecond, subDays, subHours, subMinutes, subSeconds, subWeeks } from "date-fns";
import pluralize from "pluralize";
import { getControlSubSettings } from "./settings.js";
import { isCommentId, isLinkId } from "@devvit/public-api/types/tid.js";
import { deleteAccountInitialEvaluationResults } from "./handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import { getUsernameFromUrl, getUserSocialLinks, sendMessageToWebhook } from "./utility.js";
import { getUserExtended } from "./extendedDevvit.js";
import { storeClassificationEvent } from "./statistics/classificationStatistics.js";
import { USER_DEFINED_HANDLES_POSTS } from "./statistics/definedHandlesStatistics.js";
import { RedisHelper } from "./redisHelper.js";
import { ZMember } from "@devvit/protos";

const ACTIVE_USER_STORE = "UserStore";
const TEMP_DECLINE_STORE = "TempDeclineStore";
const RECENT_CHANGES_STORE = "RecentChangesStore";

export const BIO_TEXT_STORE = "BioTextStore";
export const DISPLAY_NAME_STORE = "DisplayNameStore";
export const SOCIAL_LINKS_STORE = "SocialLinksStore";

export const AGGREGATE_STORE = "AggregateStore";

const WIKI_UPDATE_DUE = "WikiUpdateDue";
const WIKI_PAGE = "botbouncer";
const MAX_WIKI_PAGE_SIZE = 512 * 1024;

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

export enum UserFlag {
    HackedAndRecovered = "recovered",
    Scammed = "scammed",
    Locked = "locked",
}

const eligibleFlagsForStatus: Record<UserFlag, UserStatus[]> = {
    [UserFlag.HackedAndRecovered]: [UserStatus.Pending, UserStatus.Organic, UserStatus.Declined],
    [UserFlag.Scammed]: [UserStatus.Pending, UserStatus.Organic, UserStatus.Declined],
    [UserFlag.Locked]: [UserStatus.Banned],
};

export interface UserDetails {
    trackingPostId: string;
    userStatus: UserStatus;
    lastStatus?: UserStatus;
    lastUpdate: number;
    submitter?: string;
    operator?: string;
    reportedAt?: number;
    mostRecentActivity?: number;
    flags?: UserFlag[];
}

interface UserDetailsForWiki {
    trackingPostId?: string;
    userStatus: UserStatus;
    lastStatus?: UserStatus;
    lastUpdate: number;
    submitter?: string;
    operator?: string;
    reportedAt?: number;
    bioText?: string;
    mostRecentActivity?: number;
}

const ALL_POTENTIAL_USER_PREFIXES = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");

function getStoreKey (username: string): string {
    if (username.length === 0) {
        throw new Error("Empty username provided to getStoreKey");
    }
    return `UserStore~${username[0]}`;
}

async function getActiveDataStore (context: TriggerContext): Promise<Record<string, string>> {
    const redisHelper = new RedisHelper(context.redis);
    return redisHelper.hMGetAllChunked(ACTIVE_USER_STORE, 10000);
}

export async function getFullDataStore (context: TriggerContext): Promise<Record<string, string>> {
    const dataArray = await Promise.all(ALL_POTENTIAL_USER_PREFIXES.map(prefix => context.redis.global.hGetAll(getStoreKey(prefix))));
    const data = Object.assign({}, ...dataArray) as Record<string, string>;

    return { ...data };
}

export async function getAllKnownUsers (context: TriggerContext): Promise<string[]> {
    const users = await Promise.all(ALL_POTENTIAL_USER_PREFIXES.map(prefix => context.redis.global.hKeys(getStoreKey(prefix))));

    return uniq([...users.flat()]);
}

export async function getUserStatus (username: string, context: TriggerContext) {
    const value = await context.redis.global.hGet(getStoreKey(username), username);
    if (value) {
        return JSON.parse(value) as UserDetails;
    }
}

async function addModNote (options: CreateModNoteOptions, context: TriggerContext) {
    try {
        await context.reddit.addModNote(options);
    } catch {
        console.warn(`Failed to add mod note for ${options.user}, likely deleted account.`);
    }
}

export async function writeUserStatus (username: string, details: UserDetails, context: TriggerContext) {
    let isStale = false;
    if (details.mostRecentActivity && new Date(details.mostRecentActivity) < subWeeks(new Date(), 3)) {
        isStale = true;
    }

    if ((details.userStatus === UserStatus.Purged || details.userStatus === UserStatus.Retired) && details.lastUpdate < subDays(new Date(), 1).getTime()) {
        isStale = true;
    }

    try {
        await context.redis.global.hSet(getStoreKey(username), { [username]: JSON.stringify(details) });
        if (isStale) {
            await context.redis.hDel(ACTIVE_USER_STORE, [username]);
        } else {
            await context.redis.hSet(ACTIVE_USER_STORE, { [username]: JSON.stringify(details) });
        }
    } catch (error) {
        console.error(`Failed to write user status of ${details.userStatus} for ${username}:`, error);
        throw new Error(`Failed to write user status for ${username}`);
    }
}

export async function setUserStatus (username: string, details: UserDetails, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT && !isLinkId(details.trackingPostId) && !isCommentId(details.trackingPostId)) {
        throw new Error(`Tracking post ID is missing or invalid for ${username}: ${details.trackingPostId}!`);
    }

    const currentStatus = await getUserStatus(username, context);

    const statusesForLastStatusCopy = [
        UserStatus.Banned,
        UserStatus.Service,
        UserStatus.Organic,
        UserStatus.Declined,
    ];

    if (currentStatus?.userStatus && statusesForLastStatusCopy.includes(currentStatus.userStatus)) {
        details.lastStatus = currentStatus.userStatus;
    }

    // Set the reported at date from the original date, or current date/time if not set.
    details.reportedAt ??= currentStatus?.reportedAt ?? new Date().getTime();

    if (currentStatus?.mostRecentActivity && !details.mostRecentActivity) {
        details.mostRecentActivity = currentStatus.mostRecentActivity;
    }

    if (details.flags && details.flags.length > 0) {
        details.flags = details.flags.filter(flag => eligibleFlagsForStatus[flag].includes(details.userStatus));
        if (details.flags.length === 0) {
            console.log("User flags cleared due to new status.");
            delete details.flags;
        }
    }

    await writeUserStatus(username, details, context);

    if (details.userStatus !== UserStatus.Purged && details.userStatus !== UserStatus.Retired && context.subredditName === CONTROL_SUBREDDIT) {
        await context.redis.set(WIKI_UPDATE_DUE, "true");
    }

    if (context.subredditName === CONTROL_SUBREDDIT) {
        if (details.userStatus === UserStatus.Pending && !currentStatus) {
            await setCleanupForUser(username, context.redis, addMinutes(new Date(), 2));
        } else if (details.userStatus === UserStatus.Pending || details.userStatus === UserStatus.Purged || details.userStatus === UserStatus.Retired) {
            await setCleanupForUser(username, context.redis, addHours(new Date(), 1));
        } else {
            await setCleanupForUser(username, context.redis);
        }

        const submittersAndMods = uniq(compact([details.submitter, details.operator]));
        await setCleanupForSubmittersAndMods(submittersAndMods, context);

        if (details.userStatus !== currentStatus?.userStatus) {
            await updateAggregate(details.userStatus, 1, context.redis);
            if (currentStatus) {
                await updateAggregate(currentStatus.userStatus, -1, context.redis);
            }
        }
    }

    if (context.subredditName === CONTROL_SUBREDDIT && currentStatus?.userStatus !== details.userStatus && details.userStatus !== UserStatus.Pending) {
        await addModNote({
            subreddit: context.subredditName,
            user: username,
            note: `Status changed to ${details.userStatus} by ${details.operator}.`,
        }, context);
    }

    if (currentStatus?.userStatus === UserStatus.Pending && details.userStatus !== UserStatus.Pending && details.operator && details.operator !== context.appName) {
        await storeClassificationEvent(details.operator, context);
    }

    await context.redis.global.zAdd(RECENT_CHANGES_STORE, { member: username, score: new Date().getTime() });
}

export async function removeStaleRecentChangesEntries (context: TriggerContext) {
    const removedEntries = await context.redis.global.zRemRangeByScore(RECENT_CHANGES_STORE, 0, subDays(new Date(), 7).getTime());
    console.log(`Data Store: Cleaned up ${removedEntries} entries from the recent changes store.`);
}

/**
 * Touch the user status by updating the last update and most recent activity timestamps.
 * @param username The username of the user to update.
 * @param userDetails The user details to update.
 * @param context The trigger context.
 */
export async function touchUserStatus (username: string, userDetails: UserDetails, context: TriggerContext) {
    const currentEntry = await getUserStatus(username, context);
    if (currentEntry && currentEntry.lastUpdate > subWeeks(new Date(), 1).getTime()) {
        return;
    }
    const newDetails = { ...userDetails };
    newDetails.lastUpdate = Date.now();
    newDetails.mostRecentActivity = Date.now();
    await writeUserStatus(username, newDetails, context);
    console.log(`Data Store: Touched status for ${username}`);
}

export async function deleteUserStatus (username: string, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("deleteUserStatus can only be called from the control subreddit.");
    }

    await context.redis.global.hDel(getStoreKey(username), [username]);
    await context.redis.hDel(ACTIVE_USER_STORE, [username]);
    await context.redis.global.zRem(RECENT_CHANGES_STORE, [username]);

    await deleteAccountInitialEvaluationResults(username, context);
    await context.redis.hDel(BIO_TEXT_STORE, [username]);
    await context.redis.hDel(DISPLAY_NAME_STORE, [username]);
    await context.redis.hDel(SOCIAL_LINKS_STORE, [username]);
    await context.redis.hDel(USER_DEFINED_HANDLES_POSTS, [username]);

    await context.redis.global.zRem(TEMP_DECLINE_STORE, [username]);
}

export async function getUsernameFromPostId (postId: string, context: TriggerContext): Promise<string | undefined> {
    const post = await context.reddit.getPostById(postId);
    return getUsernameFromUrl(post.url);
}

export async function updateAggregate (type: UserStatus, incrBy: number, redis: TxClientLike | RedisClient) {
    await redis.zIncrBy(AGGREGATE_STORE, type, incrBy);
}

function compressData (value: Record<string, string>): string {
    return Buffer.from(pako.deflate(JSON.stringify(value), { level: 9 })).toString("base64");
}

function compactDataForWiki (input: string): string | undefined {
    const status = JSON.parse(input) as UserDetailsForWiki;

    // Exclude entries for users marked as "purged" or "retired" after an hour
    if ((status.userStatus === UserStatus.Purged || status.userStatus === UserStatus.Retired) && status.lastUpdate < subHours(new Date(), 1).getTime()) {
        return;
    }

    // Exclude entries for any user whose last observed activity is older than 4 weeks
    if (status.mostRecentActivity && status.mostRecentActivity < subWeeks(new Date(), 4).getTime()) {
        return;
    }

    // Exclude entries for organic/declined users older than 2 weeks
    if ((status.userStatus === UserStatus.Organic || status.userStatus === UserStatus.Declined) && status.lastUpdate < subWeeks(new Date(), 2).getTime()) {
        return;
    }

    delete status.operator;
    delete status.submitter;
    if (status.userStatus === UserStatus.Purged && status.lastStatus) {
        status.userStatus = status.lastStatus;
    }
    delete status.lastStatus;

    if (status.lastUpdate < subDays(new Date(), 1).getTime()) {
        status.lastUpdate = 0;
    } else {
        // Truncate the last update date/time to the end of the second.
        status.lastUpdate = addSeconds(startOfSecond(new Date(status.lastUpdate)), 1).getTime();
    }

    delete status.reportedAt;
    delete status.bioText;
    delete status.mostRecentActivity;

    if (status.userStatus !== UserStatus.Banned) {
        delete status.trackingPostId;
    }

    return JSON.stringify(status);
}

export async function updateWikiPage (_: unknown, context: JobContext) {
    const updateDue = await context.redis.exists(WIKI_UPDATE_DUE);
    if (!updateDue) {
        return;
    }

    const controlSubSettings = await getControlSubSettings(context);

    const lastUpdateDoneKey = "lastWikiUpdateDone";
    const lastUpdateDoneValue = await context.redis.get(lastUpdateDoneKey);
    if (lastUpdateDoneValue) {
        const lastUpdateDone = new Date(parseInt(lastUpdateDoneValue));
        if (lastUpdateDone > subSeconds(subMinutes(new Date(), controlSubSettings.legacyWikiPageUpdateFrequencyMinutes), 30)) {
            return;
        }
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    const data = await getActiveDataStore(context);
    const dataToWrite: Record<string, string> = {};
    const entries = Object.entries(data);
    if (entries.length === 0) {
        return;
    }

    for (const entry of entries) {
        const [username, jsonData] = entry;
        const compactedData = compactDataForWiki(jsonData);
        if (compactedData) {
            dataToWrite[username] = compactedData;
        }
    }

    // Add in entries from temp decline store.
    const tempDeclineEntries = await context.redis.global.zRange(TEMP_DECLINE_STORE, 0, -1);
    console.log(`Found ${tempDeclineEntries.length} ${pluralize("entry", tempDeclineEntries.length)} in the temp decline store`);
    for (const entry of tempDeclineEntries) {
        if (dataToWrite[entry.member]) {
            continue;
        }

        let declineStatus: UserStatus;
        const userStatus = await getUserStatus(entry.member, context);
        if (userStatus) {
            if (userStatus.userStatus === UserStatus.Purged || userStatus.userStatus === UserStatus.Retired) {
                declineStatus = userStatus.lastStatus ?? userStatus.userStatus;
            } else {
                declineStatus = userStatus.userStatus;
            }
        } else {
            declineStatus = UserStatus.Declined;
        }

        const declineEntry = {
            userStatus: declineStatus,
            trackingPostId: "",
            lastUpdate: entry.score,
            operator: "",
        };

        dataToWrite[entry.member] = JSON.stringify(declineEntry);
    }

    const content = compressData(dataToWrite);
    const chunk: string[] = [];
    for (let i = 0; i < content.length; i += MAX_WIKI_PAGE_SIZE) {
        chunk.push(content.slice(i, i + MAX_WIKI_PAGE_SIZE));
    }

    const numberOfPages = controlSubSettings.numberOfWikiPages ?? 1;
    if (numberOfPages > 1) {
        for (let i = 2; i <= numberOfPages; i++) {
            await context.reddit.updateWikiPage({
                subredditName,
                content: chunk[i - 1] ?? "",
                page: `botbouncer/${i}`,
            });
            console.log(`Wiki page ${i} has been updated.`);
        }
    }

    await context.reddit.updateWikiPage({
        subredditName,
        content: chunk[0],
        page: WIKI_PAGE,
    });

    await context.redis.del(WIKI_UPDATE_DUE);

    const maxSupportedSize = MAX_WIKI_PAGE_SIZE * numberOfPages;

    console.log(`Wiki page has been updated with ${Object.keys(dataToWrite).length} entries, ${content.length.toLocaleString()} bytes, ${Math.round(content.length / maxSupportedSize * 100)}%`);

    if (content.length > maxSupportedSize * 0.9) {
        const spaceAlertKey = "wikiSpaceAlert";
        const alertDone = await context.redis.exists(spaceAlertKey);
        if (!alertDone) {
            const controlSubSettings = await getControlSubSettings(context);
            const webhook = controlSubSettings.monitoringWebhook;
            if (webhook) {
                const message: json2md.DataObject[] = [
                    { p: `The botbouncer wiki page is now at ${Math.round(content.length / maxSupportedSize * 100)}% of its maximum size. It's time to rethink how data is stored.` },
                    { p: `I will notify you again in a week if the page is still over this threshold` },
                ];

                await sendMessageToWebhook(webhook, json2md(message));
            }
            await context.redis.set(spaceAlertKey, new Date().getTime().toString(), { expiration: addWeeks(new Date(), 1) });
        }
    }

    const aggregateStore = await context.redis.zRange(AGGREGATE_STORE, 0, -1);
    const aggregateData = fromPairs(aggregateStore.map(item => ([item.member, item.score])));
    console.log(`Status: Banned ${aggregateData[UserStatus.Banned] ?? 0}, Organic ${aggregateData[UserStatus.Organic] ?? 0}, Pending ${aggregateData[UserStatus.Pending] ?? 0}`);

    await context.redis.set(lastUpdateDoneKey, new Date().getTime().toString());
}

export async function removeRecordOfSubmitterOrMod (username: string, context: TriggerContext) {
    console.log(`Cleanup: Removing records of ${username} as submitter or operator`);
    const data = await getFullDataStore(context);
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

export async function storeInitialAccountProperties (username: string, context: TriggerContext) {
    const userExtended = await getUserExtended(username, context);

    if (!userExtended) {
        return;
    }

    const promises: Promise<number>[] = [];
    if (userExtended.userDescription) {
        promises.push(context.redis.hSet(BIO_TEXT_STORE, { [username]: userExtended.userDescription }));
        console.log(`Data Store: Stored bio for ${username}`);
    }

    if (userExtended.displayName && userExtended.displayName !== username && userExtended.displayName !== `u_${username}`) {
        promises.push(context.redis.hSet(DISPLAY_NAME_STORE, { [username]: userExtended.displayName }));
        console.log(`Data Store: Stored display name for ${username}`);
    }

    const socialLinks = await getUserSocialLinks(username, context);
    if (socialLinks.length > 0) {
        promises.push(context.redis.hSet(SOCIAL_LINKS_STORE, { [username]: JSON.stringify(socialLinks) }));
        console.log(`Data Store: Stored social links for ${username}`);
    }

    await Promise.all(promises);
}

export async function getInitialAccountProperties (username: string, context: TriggerContext) {
    const [bioText, displayName, socialLinks] = await Promise.all([
        context.redis.hGet(BIO_TEXT_STORE, username),
        context.redis.hGet(DISPLAY_NAME_STORE, username),
        context.redis.hGet(SOCIAL_LINKS_STORE, username),
    ]);

    return {
        bioText,
        displayName,
        socialLinks: socialLinks ? JSON.parse(socialLinks) as UserSocialLink[] : [],
    };
}

export async function addUserToTempDeclineStore (username: string, context: TriggerContext) {
    await context.redis.global.zAdd(TEMP_DECLINE_STORE, { member: username, score: new Date().getTime() });
    await context.redis.global.zAdd(RECENT_CHANGES_STORE, { member: username, score: new Date().getTime() });
    await context.redis.set(WIKI_UPDATE_DUE, "true");

    // Remove stale entries.
    await context.redis.global.zRemRangeByScore(TEMP_DECLINE_STORE, 0, subHours(new Date(), 1).getTime());
}

export async function isUserInTempDeclineStore (username: string, context: TriggerContext): Promise<boolean> {
    const exists = await context.redis.global.zScore(TEMP_DECLINE_STORE, username);
    return exists !== undefined;
}

export async function getRecentlyChangedUsers (since: Date, now: Date, context: TriggerContext): Promise<ZMember[]> {
    return await context.redis.global.zRange(RECENT_CHANGES_STORE, since.getTime(), now.getTime(), { by: "score" });
}

export async function migrationToGlobalRedis (context: TriggerContext) {
    const migrationDoneKey = "oneOffDataMigrationDone";
    if (await context.redis.exists(migrationDoneKey)) {
        console.log("Data Store: One-off data migration already completed.");
        return;
    }

    if (context.subredditName !== CONTROL_SUBREDDIT) {
        // For non-control subreddits, just clear out the old data store.
        await context.redis.del("UserStore");
    }

    console.log("One-off data migration completed.");
    await context.redis.set(migrationDoneKey, "true");
}

export async function checkDataStoreIntegrity (context: TriggerContext) {
    const misplacedEntries: { username: string; actualPrefix: string; inCorrectStore: boolean }[] = [];

    for (const prefix of ALL_POTENTIAL_USER_PREFIXES) {
        const storeKey = getStoreKey(prefix);
        const keys = await context.redis.global.hKeys(storeKey);

        for (const key of keys.filter(key => !key.startsWith(prefix))) {
            const entryFromCorrectStore = await context.redis.global.hGet(getStoreKey(key[0]), key);
            misplacedEntries.push({ username: key, actualPrefix: key[0], inCorrectStore: !!entryFromCorrectStore });
        }
    }

    if (misplacedEntries.length === 0) {
        return;
    }

    console.warn("Data Store: Found misplaced entries:", JSON.stringify(misplacedEntries, null, 2));

    const controlSubSettings = await getControlSubSettings(context);
    const webhook = controlSubSettings.monitoringWebhook;
    if (!webhook) {
        console.warn("Data Store: No monitoring webhook configured, cannot send alert.");
        return;
    }

    const message: json2md.DataObject[] = [
        { p: `Found ${misplacedEntries.length} misplaced ${pluralize("entry", misplacedEntries.length)} in the data store.` },
        {
            table: {
                headers: ["Username", "Actual Prefix", "In Correct Store"],
                rows: misplacedEntries.map(entry => [
                    entry.username,
                    entry.actualPrefix,
                    entry.inCorrectStore ? "Yes" : "No",
                ]),
            },
        },
    ];

    await sendMessageToWebhook(webhook, json2md(message));
}
