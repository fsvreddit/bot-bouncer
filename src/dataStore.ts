import { TriggerContext, CreateModNoteOptions, UserSocialLink, TxClientLike, RedisClient } from "@devvit/public-api";
import _ from "lodash";
import { setCleanupForSubmittersAndMods, setCleanupForUser } from "./cleanup.js";
import { CONTROL_SUBREDDIT } from "./constants.js";
import { addHours, addMinutes, subDays, subHours } from "date-fns";
import pluralize from "pluralize";
import { getControlSubSettings } from "./settings.js";
import { isCommentId, isLinkId } from "@devvit/public-api/types/tid.js";
import { deleteAccountInitialEvaluationResults } from "./handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import { getUsernameFromUrl, sendMessageToWebhook } from "./utility.js";
import { getUserExtended } from "./extendedDevvit.js";
import { storeClassificationEvent } from "./statistics/classificationStatistics.js";
import { USER_DEFINED_HANDLES_POSTS } from "./statistics/definedHandlesStatistics.js";
import { ZMember } from "@devvit/protos";
import { getUserSocialLinks, hMGetAllChunked } from "devvit-helpers";

const TEMP_DECLINE_STORE = "TempDeclineStore";
const RECENT_CHANGES_STORE = "RecentChangesStore";

export const BIO_TEXT_STORE = "BioTextStore";
export const DISPLAY_NAME_STORE = "DisplayNameStore";
export const SOCIAL_LINKS_STORE = "SocialLinksStore";

export const AGGREGATE_STORE = "AggregateStore";

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
    /**
     * @deprecated This was only used for wiki functionality, which has been removed.
     */
    mostRecentActivity?: number;
    flags?: UserFlag[];
}

const ALL_POTENTIAL_USER_PREFIXES = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");

function getStoreKey (username: string): string {
    if (username.length === 0) {
        throw new Error("Empty username provided to getStoreKey");
    }
    return `UserStore~${username[0]}`;
}

export async function getFullDataStore (context: TriggerContext): Promise<Record<string, string>> {
    const dataArray = await Promise.all(ALL_POTENTIAL_USER_PREFIXES.map(prefix => hMGetAllChunked(context.redis.global as RedisClient, getStoreKey(prefix), 10000)));
    const data = Object.assign({}, ...dataArray) as Record<string, string>;

    return { ...data };
}

export async function getAllKnownUsers (context: TriggerContext): Promise<string[]> {
    const users = await Promise.all(ALL_POTENTIAL_USER_PREFIXES.map(prefix => context.redis.global.hKeys(getStoreKey(prefix))));

    return _.uniq([...users.flat()]);
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
    try {
        await context.redis.global.hSet(getStoreKey(username), { [username]: JSON.stringify(details) });
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

    if (details.flags && details.flags.length > 0) {
        details.flags = details.flags.filter(flag => eligibleFlagsForStatus[flag].includes(details.userStatus));
        if (details.flags.length === 0) {
            console.log("User flags cleared due to new status.");
            delete details.flags;
        }
    }

    await writeUserStatus(username, details, context);

    if (context.subredditName === CONTROL_SUBREDDIT) {
        if (details.userStatus === UserStatus.Pending && !currentStatus) {
            await setCleanupForUser(username, context.redis, addMinutes(new Date(), 2));
        } else if (details.userStatus === UserStatus.Pending || details.userStatus === UserStatus.Purged || details.userStatus === UserStatus.Retired) {
            await setCleanupForUser(username, context.redis, addHours(new Date(), 1));
        } else {
            await setCleanupForUser(username, context.redis);
        }

        const submittersAndMods = _.uniq(_.compact([details.submitter, details.operator]));
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

export async function deleteUserStatus (username: string, context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("deleteUserStatus can only be called from the control subreddit.");
    }

    await context.redis.global.hDel(getStoreKey(username), [username]);
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

export async function removeRecordOfSubmitterOrMod (username: string, context: TriggerContext) {
    console.log(`Cleanup: Removing records of ${username} as submitter or operator`);
    const data = await getFullDataStore(context);
    const entries = Object.entries(data).map(([key, value]) => ({ username: key, details: JSON.parse(value) as UserDetails }));

    let entriesUpdated = 0;
    for (const entry of entries.filter(item => item.details.operator === username || item.details.submitter === username)) {
        const updatedDetails = { ...entry.details };
        if (updatedDetails.operator === username) {
            delete updatedDetails.operator;
        }
        if (updatedDetails.submitter === username) {
            delete updatedDetails.submitter;
        }

        await writeUserStatus(entry.username, updatedDetails, context);
        entriesUpdated++;
    }

    console.log(`Cleanup: Removed ${entriesUpdated} ${pluralize("record", entriesUpdated)} of ${username} as submitter or operator`);
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

    const socialLinks = await getUserSocialLinks(username, context.metadata);
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

    // Remove stale entries.
    await context.redis.global.zRemRangeByScore(TEMP_DECLINE_STORE, 0, subHours(new Date(), 1).getTime());
}

export async function isUserInTempDeclineStore (username: string, context: TriggerContext): Promise<boolean> {
    return await context.redis.global.zScore(TEMP_DECLINE_STORE, username).then(exists => exists !== undefined);
}

export async function getRecentlyChangedUsers (since: Date, now: Date, context: TriggerContext): Promise<ZMember[]> {
    return await context.redis.global.zRange(RECENT_CHANGES_STORE, since.getTime(), now.getTime(), { by: "score" });
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
