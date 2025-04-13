import { JobContext, TriggerContext, WikiPagePermissionLevel, WikiPage, CreateModNoteOptions } from "@devvit/public-api";
import { compact, max, toPairs, uniq } from "lodash";
import pako from "pako";
import { scheduleAdhocCleanup, setCleanupForSubmittersAndMods, setCleanupForUsers } from "./cleanup.js";
import { ClientSubredditJob, CONTROL_SUBREDDIT } from "./constants.js";
import { addSeconds, addWeeks, startOfSecond, subDays, subHours, subWeeks } from "date-fns";
import pluralize from "pluralize";
import { getControlSubSettings } from "./settings.js";
import { isCommentId, isLinkId } from "@devvit/shared-types/tid.js";
import { USER_EVALUATION_RESULTS_KEY } from "./handleControlSubAccountEvaluation.js";
import { queueUserForActivityCheck, removeActivityCheckRecords } from "./activityHistory.js";

export const USER_STORE = "UserStore";
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
    bioText?: string;
    recentPostSubs?: string[];
    recentCommentSubs?: string[];
}

export async function getUserStatus (username: string, context: TriggerContext) {
    const value = await context.redis.hGet(USER_STORE, username);
    if (!value) {
        return;
    }

    return JSON.parse(value) as UserDetails;
}

async function addModNote (options: CreateModNoteOptions, context: TriggerContext) {
    try {
        await context.reddit.addModNote(options);
    } catch {
        console.error(`Failed to add mod note for ${options.user}`);
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

    if (currentStatus?.recentPostSubs && !details.recentPostSubs) {
        details.recentPostSubs = currentStatus.recentPostSubs;
    }
    if (currentStatus?.recentCommentSubs && !details.recentCommentSubs) {
        details.recentCommentSubs = currentStatus.recentCommentSubs;
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

    if (context.subredditName === CONTROL_SUBREDDIT && currentStatus?.userStatus !== details.userStatus && details.userStatus !== UserStatus.Pending) {
        promises.push(addModNote({
            subreddit: context.subredditName,
            user: username,
            note: `Status changed to ${details.userStatus} by ${details.operator}.`,
        }, context));
    }

    if (context.subredditName === CONTROL_SUBREDDIT && details.userStatus === UserStatus.Banned) {
        promises.push(queueUserForActivityCheck(username, context, true));
    }

    await Promise.all(promises);
    await scheduleAdhocCleanup(context);
}

export async function deleteUserStatus (usernames: string[], context: TriggerContext) {
    const currentStatuses = await Promise.all(usernames.map(username => getUserStatus(username, context)));

    const promises = [
        context.redis.hDel(USER_STORE, usernames),
        context.redis.hDel(USER_EVALUATION_RESULTS_KEY, usernames),
        usernames.map(username => removeActivityCheckRecords(username, context)),
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

    // Exclude entries for users marked as "purged" after a week
    if (status.userStatus === UserStatus.Purged && status.lastUpdate < subWeeks(new Date(), 1).getTime()) {
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
    delete status.bioText;
    delete status.recentPostSubs;
    delete status.recentCommentSubs;

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

    if (content.length > MAX_WIKI_PAGE_SIZE * 0.7) {
        const spaceAlertKey = "wikiSpaceAlert";
        const alertDone = await context.redis.exists(spaceAlertKey);
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
