import { JobContext, TriggerContext, WikiPagePermissionLevel, WikiPage, CreateModNoteOptions, UserSocialLink } from "@devvit/public-api";
import { compact, max, toPairs, uniq } from "lodash";
import pako from "pako";
import { setCleanupForSubmittersAndMods, setCleanupForUser } from "./cleanup.js";
import { ClientSubredditJob, CONTROL_SUBREDDIT } from "./constants.js";
import { addHours, addSeconds, addWeeks, startOfSecond, subDays, subHours, subWeeks } from "date-fns";
import pluralize from "pluralize";
import { getControlSubSettings } from "./settings.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { USER_EVALUATION_RESULTS_KEY } from "./handleControlSubAccountEvaluation.js";
import json2md from "json2md";
import { sendMessageToWebhook } from "./utility.js";
import { getUserExtended } from "./extendedDevvit.js";

const USER_STORE = "UserStore";
const STALE_USER_STORE = "StaleUserStore";

const BIO_TEXT_STORE = "BioTextStore";
const DISPLAY_NAME_STORE = "DisplayNameStore";
const SOCIAL_LINKS_STORE = "SocialLinksStore";

export const AGGREGATE_STORE = "AggregateStore";

const POST_STORE = "PostStore";
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
    operator: string;
    reportedAt?: number;
    /**
    * @deprecated recentPostSubs should not be used.
    */
    bioText?: string;
    /**
    * @deprecated recentPostSubs should not be used.
    */
    recentPostSubs?: string[];
    /**
    * @deprecated recentCommentSubs should not be used.
    */
    recentCommentSubs?: string[];
    mostRecentActivity?: number;
}

const ALL_POTENTIAL_USER_PREFIXES = [
    // eslint-disable-next-line @typescript-eslint/no-misused-spread
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
];

function getStaleStoreKey (username: string): string {
    return `StaleUserStore~${username[0]}`;
}

export async function getFullDataStore (context: TriggerContext): Promise<Record<string, string>> {
    const activeData = await context.redis.hGetAll(USER_STORE);
    const staleDataArray = await Promise.all(ALL_POTENTIAL_USER_PREFIXES.map(prefix => context.redis.hGetAll(getStaleStoreKey(prefix))));
    const staleData = Object.assign({}, ...staleDataArray) as Record<string, string>;
    const legacyStaleData = await context.redis.hGetAll(STALE_USER_STORE);

    return { ...activeData, ...staleData, ...legacyStaleData };
}

export async function getAllKnownUsers (context: TriggerContext): Promise<string[]> {
    const activeUsers = await context.redis.hKeys(USER_STORE);
    const staleUsers = await Promise.all(ALL_POTENTIAL_USER_PREFIXES.map(prefix => context.redis.hKeys(getStaleStoreKey(prefix))));
    const legacyStaleUsers = await context.redis.hKeys(STALE_USER_STORE);

    return uniq([...activeUsers, ...staleUsers.flat(), ...legacyStaleUsers]);
}

export async function getUserStatus (username: string, context: TriggerContext) {
    const value = await context.redis.hGet(USER_STORE, username);

    if (value) {
        return JSON.parse(value) as UserDetails;
    }

    const legacyStaleValue = await context.redis.hGet(STALE_USER_STORE, username);
    if (legacyStaleValue) {
        return JSON.parse(legacyStaleValue) as UserDetails;
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
        console.error(`Failed to add mod note for ${options.user}`);
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

    // eslint-disable-next-line @typescript-eslint/no-deprecated
    delete details.bioText;
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    delete details.recentPostSubs;
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    delete details.recentCommentSubs;

    if (isStale) {
        await context.redis.hSet(getStaleStoreKey(username), { [username]: JSON.stringify(details) });
        await context.redis.hDel(USER_STORE, [username]);
        await context.redis.hDel(STALE_USER_STORE, [username]);
    } else {
        await context.redis.hSet(USER_STORE, { [username]: JSON.stringify(details) });
        await context.redis.hDel(getStaleStoreKey(username), [username]);
        await context.redis.hDel(STALE_USER_STORE, [username]);
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

    const promises: Promise<unknown>[] = [
        writeUserStatus(username, details, context),
        context.redis.hSet(POST_STORE, { [details.trackingPostId]: username }),
    ];

    if (details.userStatus !== UserStatus.Purged && details.userStatus !== UserStatus.Retired) {
        promises.push(queueWikiUpdate(context));
    }

    if (details.userStatus === UserStatus.Pending) {
        promises.push(setCleanupForUser(username, context, true, addHours(new Date(), 1)));
    } else {
        promises.push(setCleanupForUser(username, context, true));
    }

    const submittersAndMods = uniq(compact([details.submitter, details.operator]));
    promises.push(setCleanupForSubmittersAndMods(submittersAndMods, context));

    if (details.userStatus !== currentStatus?.userStatus) {
        promises.push(updateAggregate(details.userStatus, 1, context));
        if (currentStatus) {
            promises.push(updateAggregate(currentStatus.userStatus, -1, context));
        }
    }

    if (context.subredditName === CONTROL_SUBREDDIT && currentStatus?.userStatus !== details.userStatus && details.userStatus !== UserStatus.Pending) {
        promises.push(addModNote({
            subreddit: context.subredditName,
            user: username,
            note: `Status changed to ${details.userStatus} by ${details.operator}.`,
        }, context));
    }

    await Promise.all(promises);
}

export async function deleteUserStatus (username: string, context: TriggerContext) {
    const currentStatus = await getUserStatus(username, context);

    const promises: Promise<number>[] = [
        context.redis.hDel(USER_STORE, [username]),
        context.redis.hDel(STALE_USER_STORE, [username]),
        context.redis.hDel(USER_EVALUATION_RESULTS_KEY, [username]),
        context.redis.hDel(BIO_TEXT_STORE, [username]),
        context.redis.hDel(DISPLAY_NAME_STORE, [username]),
        context.redis.hDel(SOCIAL_LINKS_STORE, [username]),
    ];

    if (currentStatus?.trackingPostId) {
        promises.push(context.redis.hDel(POST_STORE, [currentStatus.trackingPostId]));
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

async function queueWikiUpdate (context: TriggerContext) {
    if (context.subredditName !== CONTROL_SUBREDDIT) {
        return;
    }

    await context.redis.set(WIKI_UPDATE_DUE, "true");
}

function compressData (value: Record<string, string>): string {
    return Buffer.from(pako.deflate(JSON.stringify(value), { level: 9 })).toString("base64");
}

function compactDataForWiki (input: string): string | undefined {
    const status = JSON.parse(input) as UserDetails;

    // Exclude entries for users marked as "retired" after a day
    if (status.userStatus === UserStatus.Retired && status.lastUpdate < subDays(new Date(), 1).getTime()) {
        return;
    }

    // Exclude entries for users marked as "purged" or "retired" after an hour
    if ((status.userStatus === UserStatus.Purged || status.userStatus === UserStatus.Retired) && status.lastUpdate < subHours(new Date(), 1).getTime()) {
        return;
    }

    // Exclude entries for any user whose last observed activity is older than 4 weeks
    if (status.mostRecentActivity && status.mostRecentActivity < subWeeks(new Date(), 4).getTime()) {
        return;
    }

    status.operator = "";
    delete status.submitter;
    if (status.userStatus === UserStatus.Purged && status.lastStatus) {
        status.userStatus = status.lastStatus;
    }
    delete status.lastStatus;
    if (status.lastUpdate < subDays(new Date(), 2).getTime()) {
        status.lastUpdate = 0;
    } else {
        // Truncate the last update date/time to the end of the second.
        status.lastUpdate = addSeconds(startOfSecond(new Date(status.lastUpdate)), 1).getTime();
    }

    delete status.reportedAt;
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    delete status.bioText;
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    delete status.recentPostSubs;
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    delete status.recentCommentSubs;
    delete status.mostRecentActivity;

    if (status.userStatus !== UserStatus.Banned) {
        status.trackingPostId = "";
    }

    return JSON.stringify(status);
}

export async function updateWikiPage (_: unknown, context: JobContext) {
    const updateDue = await context.redis.exists(WIKI_UPDATE_DUE);
    if (!updateDue) {
        return;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, WIKI_PAGE);
    } catch {
        //
    }

    const data = await context.redis.hGetAll(USER_STORE);
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

    const content = compressData(dataToWrite);
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

    console.log(`Wiki page has been updated with ${Object.keys(dataToWrite).length} entries`);

    if (content.length > MAX_WIKI_PAGE_SIZE * 0.75) {
        const spaceAlertKey = "wikiSpaceAlert";
        const alertDone = await context.redis.exists(spaceAlertKey);
        if (!alertDone) {
            const controlSubSettings = await getControlSubSettings(context);
            const webhook = controlSubSettings.monitoringWebhook;
            if (webhook) {
                const message: json2md.DataObject[] = [
                    { p: `The botbouncer wiki page is now at ${Math.round(content.length / MAX_WIKI_PAGE_SIZE * 100)}% of its maximum size. It's time to rethink how data is stored.` },
                    { p: `I will notify you again in a week if the page is still over this threshold` },
                ];

                await sendMessageToWebhook(webhook, json2md(message));
            }
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
                name: ClientSubredditJob.HandleClassificationChanges,
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
