import { JobContext, TriggerContext, WikiPage, CreateModNoteOptions, UserSocialLink, TxClientLike, RedisClient } from "@devvit/public-api";
import { chunk, compact, fromPairs, max, toPairs, uniq } from "lodash";
import pako from "pako";
import { setCleanupForSubmittersAndMods, setCleanupForUser } from "./cleanup.js";
import { ClientSubredditJob, CONTROL_SUBREDDIT } from "./constants.js";
import { addHours, addMinutes, addSeconds, addWeeks, startOfSecond, subDays, subHours, subWeeks } from "date-fns";
import pluralize from "pluralize";
import { getControlSubSettings } from "./settings.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { deleteAccountInitialEvaluationResults } from "./handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import { sendMessageToWebhook } from "./utility.js";
import { getUserExtended } from "./extendedDevvit.js";
import { storeClassificationEvent } from "./statistics/classificationStatistics.js";
import { queueReclassifications } from "./handleClientSubredditWikiUpdate.js";

const USER_STORE = "UserStore";
const TEMP_DECLINE_STORE = "TempDeclineStore";

export const BIO_TEXT_STORE = "BioTextStore";
export const DISPLAY_NAME_STORE = "DisplayNameStore";
export const SOCIAL_LINKS_STORE = "SocialLinksStore";

export const AGGREGATE_STORE = "AggregateStore";

export const POST_STORE = "PostStore";
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

export interface UserDetails {
    trackingPostId: string;
    userStatus: UserStatus;
    lastStatus?: UserStatus;
    lastUpdate: number;
    submitter?: string;
    operator?: string;
    reportedAt?: number;
    /**
    * @deprecated bioText should not be used.
    */
    bioText?: string;
    mostRecentActivity?: number;
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

function getStaleStoreKey (username: string): string {
    return `StaleUserStore~${username[0]}`;
}

export async function getActiveDataStore (context: TriggerContext): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    const activeKeys = await context.redis.hKeys(USER_STORE);
    const chunkedKeys = chunk(activeKeys, 10000);
    console.log(`Data Store: Fetching ${activeKeys.length} active user records in ${chunkedKeys.length} chunks.`);
    await Promise.all(chunkedKeys.map(async (keys) => {
        const data = await context.redis.hMGet(USER_STORE, keys);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const record = data[i];
            if (record) {
                results[key] = record;
            }
        }
    }));
    return results;
}

export async function getFullDataStore (context: TriggerContext): Promise<Record<string, string>> {
    const activeData = await getActiveDataStore(context);
    const staleDataArray = await Promise.all(ALL_POTENTIAL_USER_PREFIXES.map(prefix => context.redis.hGetAll(getStaleStoreKey(prefix))));
    const staleData = Object.assign({}, ...staleDataArray) as Record<string, string>;

    return { ...activeData, ...staleData };
}

export async function getAllKnownUsers (context: TriggerContext): Promise<string[]> {
    const activeUsers = await context.redis.hKeys(USER_STORE);
    const staleUsers = await Promise.all(ALL_POTENTIAL_USER_PREFIXES.map(prefix => context.redis.hKeys(getStaleStoreKey(prefix))));

    return uniq([...activeUsers, ...staleUsers.flat()]);
}

export async function getUserStatus (username: string, context: TriggerContext) {
    const value = await context.redis.hGet(USER_STORE, username);

    if (value) {
        return JSON.parse(value) as UserDetails;
    }

    const staleValue = await context.redis.hGet(getStaleStoreKey(username), username);
    if (staleValue) {
        return JSON.parse(staleValue) as UserDetails;
    }
}

async function addModNote (options: CreateModNoteOptions, context: TriggerContext) {
    try {
        await context.reddit.addModNote(options);
    } catch {
        console.warn(`Failed to add mod note for ${options.user}, likely deleted account.`);
    }
}

export async function writeUserStatus (username: string, details: UserDetails, redis: TxClientLike | RedisClient) {
    let isStale = false;
    if (details.mostRecentActivity && new Date(details.mostRecentActivity) < subWeeks(new Date(), 3)) {
        isStale = true;
    }

    if ((details.userStatus === UserStatus.Purged || details.userStatus === UserStatus.Retired) && details.lastUpdate < subDays(new Date(), 1).getTime()) {
        isStale = true;
    }

    const keyToSet = isStale ? getStaleStoreKey(username) : USER_STORE;
    const keyToDelete = isStale ? USER_STORE : getStaleStoreKey(username);

    try {
        await redis.hSet(keyToSet, { [username]: JSON.stringify(details) });
        await redis.hDel(keyToDelete, [username]);
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

    if (currentStatus?.userStatus === UserStatus.Banned || currentStatus?.userStatus === UserStatus.Service || currentStatus?.userStatus === UserStatus.Organic) {
        details.lastStatus = currentStatus.userStatus;
    }

    // Set the reported at date from the original date, or current date/time if not set.
    details.reportedAt ??= currentStatus?.reportedAt ?? new Date().getTime();

    if (currentStatus?.mostRecentActivity && !details.mostRecentActivity) {
        details.mostRecentActivity = currentStatus.mostRecentActivity;
    }

    if (currentStatus && details.userStatus === UserStatus.Purged) {
        details.lastUpdate = currentStatus.lastUpdate;
    }

    const txn = await context.redis.watch();
    await txn.multi();
    await writeUserStatus(username, details, txn);
    await txn.hSet(POST_STORE, { [details.trackingPostId]: username });

    if (details.userStatus !== UserStatus.Purged && details.userStatus !== UserStatus.Retired && context.subredditName === CONTROL_SUBREDDIT) {
        await txn.set(WIKI_UPDATE_DUE, "true");
    }

    if (context.subredditName === CONTROL_SUBREDDIT) {
        if (details.userStatus === UserStatus.Pending && !currentStatus) {
            await setCleanupForUser(username, txn, addMinutes(new Date(), 2));
        } else if (details.userStatus === UserStatus.Pending || details.userStatus === UserStatus.Purged || details.userStatus === UserStatus.Retired) {
            await setCleanupForUser(username, txn, addHours(new Date(), 1));
        } else {
            await setCleanupForUser(username, txn);
        }

        const submittersAndMods = uniq(compact([details.submitter, details.operator]));
        await setCleanupForSubmittersAndMods(submittersAndMods, txn);

        if (details.userStatus !== currentStatus?.userStatus) {
            await updateAggregate(details.userStatus, 1, txn);
            if (currentStatus) {
                await updateAggregate(currentStatus.userStatus, -1, txn);
            }
        }
    }

    await txn.exec();

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
}

export async function deleteUserStatus (username: string, trackingPostId: string | undefined, txn: TxClientLike) {
    await txn.hDel(USER_STORE, [username]);
    await txn.hDel(getStaleStoreKey(username), [username]);
    await deleteAccountInitialEvaluationResults(username, txn);
    await txn.hDel(BIO_TEXT_STORE, [username]);
    await txn.hDel(DISPLAY_NAME_STORE, [username]);
    await txn.hDel(SOCIAL_LINKS_STORE, [username]);

    if (trackingPostId) {
        await txn.hDel(POST_STORE, [trackingPostId]);
    }
}

export async function getUsernameFromPostId (postId: string, context: TriggerContext): Promise<string | undefined> {
    const username = await context.redis.hGet(POST_STORE, postId);
    return username;
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
    const tempDeclineEntries = await context.redis.zRange(TEMP_DECLINE_STORE, 0, -1);
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

    const controlSubSettings = await getControlSubSettings(context);
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

    console.log(`Wiki page has been updated with ${Object.keys(dataToWrite).length} entries, size: ${content.length.toLocaleString()} bytes`);

    const maxSupportedSize = MAX_WIKI_PAGE_SIZE * numberOfPages;
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
                console.log(`Wiki Update: Reading wiki page ${i} from control subreddit`);
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
        .map(([username, userdata]) => ({ username, data: JSON.parse(userdata) as UserDetails }));

    const oneOffReaffirmationKey = "oneOffReaffirmation";
    const reaffirmationDone = await context.redis.exists(oneOffReaffirmationKey);
    if (!reaffirmationDone) {
        const usersToReaffirm = usersWithStatus.filter(item => item.data.userStatus === UserStatus.Organic || item.data.userStatus === UserStatus.Declined || item.data.userStatus === UserStatus.Service);
        await queueReclassifications(usersToReaffirm.map(item => ({ member: item.username, score: item.data.lastUpdate })), context);
        await context.redis.set(oneOffReaffirmationKey, "true");
        console.log(`Wiki Update: One-off reaffirmation for ${usersToReaffirm.length} ${pluralize("user", usersToReaffirm.length)} has been queued.`);
    }

    const recentUsersWithStatus = usersWithStatus.filter(item => new Date(item.data.lastUpdate) > lastUpdateDate);

    if (recentUsersWithStatus.length > 0) {
        const newUpdateDate = max(recentUsersWithStatus.map(item => item.data.lastUpdate)) ?? new Date().getTime();

        const recentItems = recentUsersWithStatus.filter(item => new Date(item.data.lastUpdate) > lastUpdateDate);

        if (recentItems.length > 0) {
            await queueReclassifications(recentItems.map(item => ({ member: item.username, score: item.data.lastUpdate })), context);
            await context.scheduler.runJob({
                name: ClientSubredditJob.HandleClassificationChanges,
                runAt: new Date(),
            });

            console.log(`Wiki Update: ${recentItems.length} ${pluralize("user", recentItems.length)} ${pluralize("has", recentItems.length)} been reclassified. Job scheduled to update local store.`);
        }

        await context.redis.set(lastUpdateDateKey, newUpdateDate.toString());
    } else {
        console.log("Wiki Update: Finished processing.");
    }

    await context.redis.set(lastUpdateKey, wikiPage.revisionId);
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
    const [userExtended, user] = await Promise.all([
        getUserExtended(username, context),
        context.reddit.getUserByUsername(username),
    ]);

    if (!userExtended || !user) {
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

    const socialLinks = await user.getSocialLinks();
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
    await context.redis.zAdd(TEMP_DECLINE_STORE, { member: username, score: new Date().getTime() });
    await context.redis.set(WIKI_UPDATE_DUE, "true");

    // Remove stale entries.
    await context.redis.zRemRangeByScore(TEMP_DECLINE_STORE, 0, subHours(new Date(), 1).getTime());
}
