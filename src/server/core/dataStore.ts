import { context, CreateModNoteOptions, reddit, redis, RedisClient, UserSocialLink, ZMember } from "@devvit/web/server";
import { isT1, isT3, T3 } from "@devvit/web/shared";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { UserFlag } from "./types";
import { hGetAllChunked } from "./redisHelpers";
import { CONTROL_SUBREDDIT } from "./constants";
import { addDays, addHours, addMinutes, subDays, subHours } from "date-fns";
import { getUsernameFromUrl } from "./utility";
import { getUserExtended, getUserSocialLinks } from "@fsvreddit/fsv-devvit-web-helpers";
import { setCleanupForSubmittersAndMods, setCleanupForUser } from "./cleanup";
import pluralize from "pluralize";
import { deleteAccountInitialEvaluationResults } from ".";
import { storeClassificationEvent } from "./controlSubCore/statistics";
import { deleteAppealRecordsForUser, removeUserFromReversalsQueue } from "./controlSubCore/modmail";
import { compact, fromPairs, uniq } from "lodash-es";

const TEMP_DECLINE_STORE = "TempDeclineStore";
const RECENT_CHANGES_STORE = "RecentChangesStore";

export const USER_DEFINED_HANDLES_POSTS = "userDefinedHandlesPosts";
export const BIO_TEXT_STORE = "BioTextStore";
export const DISPLAY_NAME_STORE = "DisplayNameStore";
export const SOCIAL_LINKS_STORE = "SocialLinksStore";

export const AGGREGATE_STORE = "AggregateStore";

const eligibleFlagsForStatus: Record<UserFlag, UserStatus[]> = {
    [UserFlag.HackedAndRecovered]: [UserStatus.Pending, UserStatus.Organic],
    [UserFlag.Scammed]: [UserStatus.Pending, UserStatus.Organic],
    [UserFlag.Locked]: [UserStatus.Banned],
    [UserFlag.FutureNSFW]: [UserStatus.Organic],
};

export interface UserDetails {
    trackingPostId: `t3_${string}` | "";
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

export const ALL_POTENTIAL_USER_PREFIXES = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");

function getStoreKey (username: string): string {
    if (username.length === 0) {
        throw new Error("Empty username provided to getStoreKey");
    }
    return `UserStore~${username[0]}`;
}

interface DataStoreExtractFilter {
    since?: Date;
    lastUpdateSince?: Date;
    statuses?: UserStatus[];
    omitFlags?: UserFlag[];
    submitter?: string[];
    usernameRegex?: RegExp;
}

export async function getDataStoreFiltered (prefix: string, filter?: DataStoreExtractFilter): Promise<Record<string, UserDetails>> {
    const data = await hGetAllChunked(redis.global as RedisClient, getStoreKey(prefix), 5000);
    if (!filter) {
        return fromPairs(Object.entries(data).map(([key, value]) => [key, JSON.parse(value) as UserDetails]));
    }

    const sinceTime = filter.since ? filter.since.getTime() : undefined;
    const lastUpdateSinceTime = filter.lastUpdateSince ? filter.lastUpdateSince.getTime() : undefined;
    const omitFlags = filter.omitFlags ?? [];

    const filteredData: Record<string, UserDetails> = {};

    Object.entries(data).forEach(([username, value]) => {
        if (filter.usernameRegex && !filter.usernameRegex.test(username)) {
            return;
        }

        const details = JSON.parse(value) as UserDetails;
        if (sinceTime && details.reportedAt && details.reportedAt < sinceTime) {
            return;
        }

        if (lastUpdateSinceTime && details.lastUpdate < lastUpdateSinceTime) {
            return;
        }

        if (filter.statuses && !filter.statuses.includes(details.userStatus)) {
            return;
        }

        if (omitFlags.length > 0 && details.flags?.some(flag => omitFlags.includes(flag))) {
            return;
        }

        if (filter.submitter && !filter.submitter.includes(details.submitter ?? "")) {
            return;
        }

        filteredData[username] = details;
    });

    return filteredData;
}

export async function getFullDataStore (filter?: DataStoreExtractFilter): Promise<Record<string, UserDetails>> {
    const dataArray = await Promise.all(ALL_POTENTIAL_USER_PREFIXES.map(prefix => getDataStoreFiltered(prefix, filter)));
    const data = Object.assign({}, ...dataArray) as Record<string, UserDetails>;

    return { ...data };
}

export async function getAllKnownUsers (): Promise<string[]> {
    const users = await Promise.all(ALL_POTENTIAL_USER_PREFIXES.map(prefix => redis.global.hKeys(getStoreKey(prefix))));

    return uniq([...users.flat()]);
}

export async function getUserStatus (username: string) {
    const value = await redis.global.hGet(getStoreKey(username), username);
    if (value) {
        return JSON.parse(value) as UserDetails;
    }
}

async function addModNote (options: CreateModNoteOptions) {
    try {
        await reddit.addModNote(options);
    } catch {
        console.warn(`Failed to add mod note for ${options.user}, likely deleted account.`);
    }
}

export async function writeUserStatus (username: string, details: UserDetails) {
    try {
        await redis.global.hSet(getStoreKey(username), { [username]: JSON.stringify(details) });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to write user status of ${details.userStatus} for ${username}:`, message);
        throw error;
    }
}

function usernamesMatch (username1: string | undefined, username2: string | undefined): boolean {
    if (!username1 || !username2) {
        return false;
    }

    return username1.toLowerCase() === username2.toLowerCase();
}

export function shouldStoreClassificationEvent (currentStatus: UserDetails | undefined, details: UserDetails, appSlug: string | undefined): boolean {
    if (currentStatus?.userStatus !== UserStatus.Pending || details.userStatus === UserStatus.Pending || !details.operator) {
        return false;
    }

    if (usernamesMatch(details.operator, appSlug)) {
        return false;
    }

    if (usernamesMatch(details.operator, currentStatus.submitter) || usernamesMatch(details.operator, details.submitter)) {
        return false;
    }

    return true;
}

export async function setUserStatus (username: string, details: UserDetails) {
    if (context.subredditName === CONTROL_SUBREDDIT && !isT3(details.trackingPostId) && !isT1(details.trackingPostId)) {
        throw new Error(`Tracking post ID is missing or invalid for ${username}: ${details.trackingPostId}!`);
    }

    const currentStatus = await getUserStatus(username);

    const statusesForLastStatusCopy = [
        UserStatus.Banned,
        UserStatus.Service,
        UserStatus.Organic,
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

    await writeUserStatus(username, details);

    if (context.subredditName === CONTROL_SUBREDDIT) {
        let overrideDate: Date | undefined;
        if (details.userStatus === UserStatus.Pending && !currentStatus) {
            overrideDate = addMinutes(new Date(), 2);
        } else if (details.userStatus === UserStatus.Pending || details.userStatus === UserStatus.Purged || details.userStatus === UserStatus.Retired) {
            overrideDate = addHours(new Date(), 1);
        } else if (details.flags?.includes(UserFlag.FutureNSFW)) {
            overrideDate = addDays(new Date(), 7);
        } else if (details.userStatus === UserStatus.Inactive) {
            overrideDate = addDays(new Date(), 7);
        }

        await setCleanupForUser(username, overrideDate);

        const submittersAndMods = uniq(compact([details.submitter, details.operator]));
        await setCleanupForSubmittersAndMods(submittersAndMods);

        if (details.userStatus !== currentStatus?.userStatus) {
            await updateAggregate(details.userStatus, 1);
            if (currentStatus) {
                await updateAggregate(currentStatus.userStatus, -1);
            }
        }
    }

    if (context.subredditName === CONTROL_SUBREDDIT && currentStatus?.userStatus !== details.userStatus && details.userStatus !== UserStatus.Pending) {
        await addModNote({
            subreddit: context.subredditName,
            user: username,
            note: `Status changed to ${details.userStatus} by ${details.operator}.`,
        });
    }

    const classificationOperator = details.operator;
    if (classificationOperator && shouldStoreClassificationEvent(currentStatus, details, context.appSlug)) {
        await storeClassificationEvent(classificationOperator);
    }

    if (details.userStatus !== UserStatus.Pending && details.userStatus !== UserStatus.Purged && details.userStatus !== UserStatus.Retired) {
        await redis.global.zAdd(RECENT_CHANGES_STORE, { member: username, score: new Date().getTime() });
    }

    if (details.userStatus === UserStatus.Banned) {
        await removeUserFromReversalsQueue(username);
    }
}

export async function removeStaleRecentChangesEntries () {
    const removedEntries = await redis.global.zRemRangeByScore(RECENT_CHANGES_STORE, 0, subDays(new Date(), 7).getTime());
    console.log(`Data Store: Cleaned up ${removedEntries} entries from the recent changes store.`);
}

export async function deleteUserStatus (username: string) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        throw new Error("deleteUserStatus can only be called from the control subreddit.");
    }

    await redis.global.hDel(getStoreKey(username), [username]);
    await redis.global.zRem(RECENT_CHANGES_STORE, [username]);

    await deleteAccountInitialEvaluationResults(username);
    await redis.hDel(BIO_TEXT_STORE, [username]);
    await redis.hDel(DISPLAY_NAME_STORE, [username]);
    await redis.hDel(SOCIAL_LINKS_STORE, [username]);
    await redis.hDel(USER_DEFINED_HANDLES_POSTS, [username]);

    await deleteAppealRecordsForUser(username);

    await redis.global.zRem(TEMP_DECLINE_STORE, [username]);
}

export async function getUsernameFromPostId (postId: T3): Promise<string | undefined> {
    const post = await reddit.getPostById(postId);
    return getUsernameFromUrl(post.url);
}

export async function updateAggregate (type: UserStatus, incrBy: number) {
    await redis.zIncrBy(AGGREGATE_STORE, type, incrBy);
}

export async function removeRecordOfSubmitterOrMod (username: string) {
    console.log(`Cleanup: Removing records of ${username} as submitter or operator`);
    const data = await getFullDataStore({
        submitter: [username],
    });

    const entries = Object.entries(data).map(([key, value]) => ({ username: key, details: value }));

    let entriesUpdated = 0;
    for (const entry of entries.filter(item => item.details.operator === username || item.details.submitter === username)) {
        const updatedDetails = { ...entry.details };
        if (updatedDetails.operator === username) {
            delete updatedDetails.operator;
        }
        if (updatedDetails.submitter === username) {
            delete updatedDetails.submitter;
        }

        await writeUserStatus(entry.username, updatedDetails);
        entriesUpdated++;
    }

    console.log(`Cleanup: Removed ${entriesUpdated} ${pluralize("record", entriesUpdated)} of ${username} as submitter or operator`);
}

export async function storeInitialAccountProperties (username: string) {
    const userExtended = await getUserExtended(username);

    if (!userExtended) {
        return;
    }

    const promises: Promise<number>[] = [];
    if (userExtended.userDescription) {
        promises.push(redis.hSet(BIO_TEXT_STORE, { [username]: userExtended.userDescription }));
        console.log(`Data Store: Stored bio for ${username}`);
    }

    if (userExtended.displayName && userExtended.displayName !== username && userExtended.displayName !== `u_${username}`) {
        promises.push(redis.hSet(DISPLAY_NAME_STORE, { [username]: userExtended.displayName }));
        console.log(`Data Store: Stored display name for ${username}`);
    }

    const socialLinks = await getUserSocialLinks(username);
    if (socialLinks.length > 0) {
        promises.push(redis.hSet(SOCIAL_LINKS_STORE, { [username]: JSON.stringify(socialLinks) }));
        console.log(`Data Store: Stored social links for ${username}`);
    }

    await Promise.all(promises);
}

export async function getInitialAccountProperties (username: string) {
    const [bioText, displayName, socialLinks] = await Promise.all([
        redis.hGet(BIO_TEXT_STORE, username),
        redis.hGet(DISPLAY_NAME_STORE, username),
        redis.hGet(SOCIAL_LINKS_STORE, username),
    ]);

    return {
        bioText,
        displayName,
        socialLinks: socialLinks ? JSON.parse(socialLinks) as UserSocialLink[] : [],
    };
}

export async function addUserToTempDeclineStore (username: string) {
    await redis.global.zAdd(TEMP_DECLINE_STORE, { member: username, score: new Date().getTime() });
    await redis.global.zAdd(RECENT_CHANGES_STORE, { member: username, score: new Date().getTime() });

    // Remove stale entries.
    await redis.global.zRemRangeByScore(TEMP_DECLINE_STORE, 0, subHours(new Date(), 1).getTime());
}

export async function isUserInTempDeclineStore (username: string): Promise<boolean> {
    return await redis.global.zScore(TEMP_DECLINE_STORE, username).then(exists => exists !== undefined);
}

export async function getRecentlyChangedUsers (since: Date, now: Date): Promise<ZMember[]> {
    return await redis.global.zRange(RECENT_CHANGES_STORE, since.getTime(), now.getTime(), { by: "score" });
}
