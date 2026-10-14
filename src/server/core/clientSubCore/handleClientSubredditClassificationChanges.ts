import { Comment, context, Post, reddit, redis, scheduler, settings, SettingsValues, TaskRequest } from "@devvit/web/server";
import { ActionType, AppSetting, ClientSubredditJob, CONFIGURATION_DEFAULTS, expireKeyAt, getControlSubSettings, getRecentlyChangedUsers, getUserStatus, hasPermissions, isBanned, isContributor, isModeratorWithCache, isUserInTempDeclineStore, postIdToShortLink, recordBanForSummary, recordUnbanForSummary, removeRecordOfBanForSummary, setCleanupForUser, UserDetails } from "..";
import { ControlSubSettings, UserStatus } from "@fsvreddit/bot-bouncer-types";
import { T1, T3 } from "@devvit/web/shared";
import pluralize from "pluralize";
import { getPostOrCommentById, getUserOrUndefined, hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addDays, addMinutes, addSeconds, formatDate, subDays, subMinutes, subWeeks } from "date-fns";
import _ from "lodash";
import { HandleClassificationChangesData } from "../../tasks";

const UNBAN_WHITELIST = "UnbanWhitelist";
const BAN_STORE = "BanStore";
const RECLASSIFICATION_QUEUE = "ReclassificationQueue";
const NO_PERMISSIONS_QUEUE = "NoPermissionsQueue";

export async function recordBan (username: string) {
    await redis.zAdd(BAN_STORE, { member: username, score: new Date().getTime() });
    await setCleanupForUser(username);
    console.log(`Ban recorded for ${username}`);
}

export async function completeSuccessfulClientSubredditBan (
    banResult: PromiseSettledResult<unknown>,
    username: string,
    subredditName: string,
    settings: SettingsValues,
): Promise<boolean> {
    if (banResult.status === "rejected") {
        return false;
    }

    await recordBan(username);
    await recordBanForSummary(username);

    if (settings[AppSetting.AddModNoteOnClassificationChange]) {
        let modNoteText = "User banned by Bot Bouncer";
        const currentStatus = await getUserStatus(username);
        if (currentStatus?.trackingPostId) {
            modNoteText += `. Tracking post: ${postIdToShortLink(currentStatus.trackingPostId)}`;
        }

        await reddit.addModNote({
            note: modNoteText,
            subreddit: subredditName,
            user: username,
            label: "BOT_BAN",
        });
    }

    if (settings[AppSetting.RemoveFromModqueueWhenBanning]) {
        await addUserToModqueueRemovalStore(username);
    }

    return true;
}

export async function removeRecordOfBan (username: string) {
    await redis.zRem(BAN_STORE, [username]);
    await removeRecordOfBanForSummary(username);
    console.log(`Removed record of ban for ${username}`);
}

export async function wasUserBannedByApp (username: string): Promise<boolean> {
    return await redis.zScore(BAN_STORE, username).then(score => score !== undefined);
}

export async function recordWhitelistUnban (username: string) {
    const whitelistEnabled = await settings.get<boolean>(AppSetting.AutoWhitelist);
    if (!whitelistEnabled) {
        return;
    }

    const currentStatus = await getUserStatus(username);
    if (currentStatus?.userStatus !== UserStatus.Banned) {
        return;
    }

    const txn = await redis.watch();
    await txn.multi();
    await txn.zAdd(UNBAN_WHITELIST, { member: username, score: new Date().getTime() });
    await setCleanupForUser(username);
    await txn.exec();
}

export async function removeWhitelistUnban (username: string) {
    await redis.zRem(UNBAN_WHITELIST, [username]);
}

export async function isUserWhitelisted (username: string) {
    return await redis.zScore(UNBAN_WHITELIST, username).then(score => score !== undefined);
}

async function approveIfNotRemovedByMod (targetId: T1 | T3) {
    const removedByMod = await redis.exists(`removedbymod:${targetId}`);
    if (!removedByMod) {
        try {
            await reddit.approve(targetId);
        } catch (error) {
            if (error instanceof Error) {
                console.error(`Failed to approve ${targetId}:`, error.message);
            } else {
                console.error(`Failed to approve ${targetId}`);
            }
        }
    }
}

async function handleSetOrganic (username: string, subredditName: string, settings: SettingsValues, controlSubSettings: ControlSubSettings) {
    if (!controlSubSettings.allowUnbans) {
        return;
    }

    const contentToReinstate: string[] = [];

    const removedItems = await redis.hGetAll(`removedItems:${username}`);
    contentToReinstate.push(...Object.keys(removedItems));

    if (contentToReinstate.length > 0) {
        await Promise.all(contentToReinstate.map(id => approveIfNotRemovedByMod(id as T1 | T3)));
        await redis.del(`removedItems:${username}`);
        console.log(`Classification Update: Reinstated ${contentToReinstate.length} ${pluralize("item", contentToReinstate.length)} for ${username}`);
    }

    const lockedItems = await redis.hGetAll(`lockedItems:${username}`);
    const lockedItemIds = Object.keys(lockedItems);
    if (lockedItemIds.length > 0) {
        await Promise.all(lockedItemIds.map(async (id) => {
            const item = await getPostOrCommentById(id as T1 | T3);
            if (item.locked) {
                await item.unlock();
            }
        }));
        await redis.del(`lockedItems:${username}`);
        console.log(`Classification Update: Unlocked ${lockedItemIds.length} ${pluralize("item", lockedItemIds.length)} for ${username}`);
    }

    const userBannedByApp = await wasUserBannedByApp(username);
    if (!userBannedByApp) {
        return;
    }

    if (await isBanned(subredditName, username)) {
        await reddit.unbanUser(username, subredditName);
        console.log(`Classification Update: Unbanned ${username}`);
    }

    await removeRecordOfBan(username);
    await recordUnbanForSummary(username);

    if (settings[AppSetting.AddModNoteOnClassificationChange]) {
        let modNoteText = "User unbanned by Bot Bouncer after classification was changed";
        const currentStatus = await getUserStatus(username);
        if (currentStatus?.trackingPostId) {
            modNoteText += `. Tracking post: ${postIdToShortLink(currentStatus.trackingPostId)}`;
        }

        await reddit.addModNote({
            note: modNoteText,
            subreddit: subredditName,
            user: username,
        });
    }
}

async function handleSetBanned (username: string, subredditName: string, settings: SettingsValues, controlSubSettings: ControlSubSettings) {
    if (!controlSubSettings.allowBans) {
        console.log(`Classification Update: ${username} is classified as a bot but allowBans is false, so will not be actioned.`);
        return;
    }

    const isCurrentlyBanned = await isBanned(subredditName, username);
    if (isCurrentlyBanned) {
        console.log(`Classification Update: ${username} is already banned on ${subredditName}.`);
        return;
    }

    if (!await hasUserCreatedContentRecently(username)) {
        return;
    }

    let userContent: (Comment | Post)[];
    try {
        userContent = await reddit.getCommentsAndPostsByUser({
            username,
            sort: "new",
            timeframe: "week",
            limit: 1000,
        }).all();
    } catch {
        return;
    }

    const userContextItems = await redis.hKeys(`userContextItems:${username}`);
    for (const itemId of userContextItems) {
        if (!userContent.some(item => item.id === itemId)) {
            console.log(`Classification Update: Adding context item ${itemId} for ${username}`);
            userContent.unshift(await getPostOrCommentById(itemId as T1 | T3));
        }
    }

    const recentLocalContent = userContent.filter(item => item.subredditName === subredditName && item.createdAt > subWeeks(new Date(), 1));

    if (recentLocalContent.length === 0) {
        return;
    }

    if (recentLocalContent.some(item => item.distinguishedBy)) {
        console.log(`Classification Update: ${username} has distinguished content on ${subredditName}. Skipping.`);
        return;
    }

    const user = await getUserOrUndefined(username);
    if (user) {
        const flair = await user.getUserFlairBySubreddit(subredditName);
        if (flair?.flairCssClass?.toLowerCase().endsWith("proof")) {
            console.log(`Classification Update: ${user.username} is allowlisted via flair`);
            return;
        }
    }

    if (await isContributor(subredditName, username)) {
        console.log(`Classification Update: ${username} is allowlisted as an approved user`);
        return;
    }

    if (await isModeratorWithCache(username)) {
        console.log(`Classification Update: ${username} is allowlisted as a moderator`);
        return;
    }

    const removableContent = recentLocalContent.filter(item => !item.spam && !item.removed);

    const [actionToTake] = settings[AppSetting.Action] as ActionType[] | undefined ?? [ActionType.Ban];
    if (actionToTake === ActionType.Ban) {
        let message = settings[AppSetting.BanMessage] as string | undefined ?? CONFIGURATION_DEFAULTS.banMessage;
        message = message.replaceAll("{subreddit}", subredditName)
            .replaceAll("{account}", username);

        const banNote = CONFIGURATION_DEFAULTS.banNote
            .replaceAll("{me}", context.appSlug)
            .replaceAll("{date}", formatDate(new Date(), "yyyy-MM-dd"));

        const promises = [
            reddit.banUser({
                subredditName,
                username,
                message,
                note: banNote,
            }),
            ...removableContent.map(item => item.remove()),
        ];

        if (settings[AppSetting.LockContentWhenRemoving]) {
            promises.push(...removableContent.filter(item => !item.locked).map(item => item.lock()));
        }

        const results = await Promise.allSettled(promises);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const banResult = results[0]!;

        const banSucceeded = await completeSuccessfulClientSubredditBan(
            banResult,
            username,
            subredditName,
            settings,
        );

        const reinstatableContent = removableContent.filter(item => item.userReportReasons.length === 0);
        if (reinstatableContent.length > 0) {
            await redis.hSet(`removedItems:${username}`, _.fromPairs(reinstatableContent.map(item => ([item.id, item.id]))));
            // Expire key after 14 days
            await expireKeyAt(`removedItems:${username}`, addDays(new Date(), 14));

            if (settings[AppSetting.LockContentWhenRemoving]) {
                await redis.hSet(`lockedItems:${username}`, _.fromPairs(reinstatableContent.map(item => ([item.id, item.id]))));
                await expireKeyAt(`lockedItems:${username}`, addDays(new Date(), 14));
            }
        }

        if (banResult.status === "rejected") {
            console.error(`Classification Update: Failed to ban ${username} on ${subredditName}.`);
            console.log(banResult.reason);
        }

        const failedContentActions = results.slice(1).filter(result => result.status === "rejected");
        if (failedContentActions.length > 0) {
            console.error(`Classification Update: Some content removal or locking actions failed for ${username} on ${subredditName}.`);
            console.log(failedContentActions);
        } else if (banSucceeded) {
            console.log(`Classification Update: 💥 ${username} has been banned following classification update. ${removableContent.length} ${pluralize("item", removableContent.length)} removed.`);
        }
    } else if (actionToTake === ActionType.Filter) {
        await Promise.all(removableContent.map(async (item) => {
            await reddit.filter(item.id, { keep: false, reason: "User is listed as a bot on r/BotBouncer" });
        }));
    } else { // Report
        // Report content instead of banning.
        await Promise.all(removableContent.map(async (item) => {
            const itemReported = await redis.get(`reported:${item.id}`);
            if (!itemReported) {
                await reddit.report(item, { reason: "User is listed as a bot on r/BotBouncer" });
            }
        }));
    }
}

export async function queueRecentReclassifications () {
    const now = new Date();
    const lastCheckKey = "lastUpdateDateKey";
    const lastCheckData = await redis.get(lastCheckKey);
    const lastCheckDate = lastCheckData ? new Date(parseInt(lastCheckData, 10)) : subDays(now, 7);

    const recentlyChangedUsers = await getRecentlyChangedUsers(lastCheckDate, now);
    let processedUntil = now;

    if (recentlyChangedUsers.length > 0) {
        await redis.zAdd(RECLASSIFICATION_QUEUE, ...recentlyChangedUsers);
        console.log(`Classification Update: Queued ${recentlyChangedUsers.length} ${pluralize("user", recentlyChangedUsers.length)} for reclassification.`);
        processedUntil = new Date(Math.max(...recentlyChangedUsers.map(u => u.score)) + 1);
    }

    await redis.set(lastCheckKey, processedUntil.getTime().toString());

    await scheduler.runJob<HandleClassificationChangesData>({
        name: ClientSubredditJob.HandleClassificationChanges,
        runAt: addSeconds(new Date(), 1),
        data: { firstRun: true, jobGuid: crypto.randomUUID() },
    });
}

function effectiveStatus (userDetails?: UserDetails): "human" | "bot" | undefined {
    if (!userDetails) {
        return;
    }

    if (userDetails.userStatus === UserStatus.Pending) {
        return;
    }

    if (userDetails.userStatus === UserStatus.Organic || userDetails.userStatus === UserStatus.Service || userDetails.userStatus === UserStatus.Inactive) {
        return "human";
    }

    if (userDetails.userStatus === UserStatus.Banned) {
        return "bot";
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (userDetails.userStatus === UserStatus.Purged || userDetails.userStatus === UserStatus.Retired) {
        if (userDetails.lastStatus === undefined) {
            return "bot";
        }

        if (userDetails.lastStatus === UserStatus.Purged || userDetails.lastStatus === UserStatus.Retired) {
            return;
        }

        return effectiveStatus({ ...userDetails, userStatus: userDetails.lastStatus, lastStatus: undefined });
    }
}

async function handleReclassificationWithPermissions (username: string, status: "human" | "bot" | undefined, subredditName: string, settings: SettingsValues, controlSubSettings: ControlSubSettings) {
    if (status === "human") {
        await handleSetOrganic(username, subredditName, settings, controlSubSettings);
    } else if (status === "bot") {
        await handleSetBanned(username, subredditName, settings, controlSubSettings);
    } else if (await isUserInTempDeclineStore(username)) {
        await handleSetOrganic(username, subredditName, settings, controlSubSettings);
    }
}

async function handleReclassificationWithoutPermissions (username: string, status: "human" | "bot" | undefined) {
    if (status !== "human") {
        return;
    }

    const userBannedByApp = await wasUserBannedByApp(username);
    if (!userBannedByApp) {
        return;
    }

    await redis.zAdd(NO_PERMISSIONS_QUEUE, { score: Date.now(), member: username });
}

async function reinstateItemsFromNoPermissionsQueue () {
    const items = await redis.zRange(NO_PERMISSIONS_QUEUE, 0, -1);
    if (items.length === 0) {
        return;
    }

    await redis.zAdd(RECLASSIFICATION_QUEUE, ...items);
    await redis.zRem(NO_PERMISSIONS_QUEUE, items.map(item => item.member));
}

export async function handleClassificationChanges (event: TaskRequest<HandleClassificationChangesData>) {
    const recentlyRunKey = "classificationChangesInProgress";
    if (event.data.firstRun && await redis.exists(recentlyRunKey)) {
        console.log("Classification Update: Classification changes job ran recently, skipping this run.");
        return;
    }

    const jobGuid = event.data.jobGuid;
    if (jobGuid && await hasTriggerBeenHandled(`job:${jobGuid}`, { expiration: addMinutes(new Date(), 5) })) {
        console.warn(`Classification Update: Job with guid ${jobGuid} has already been handled, skipping.`);
        return;
    }

    await redis.set(recentlyRunKey, "true", { expiration: addSeconds(new Date(), 30) });

    const runLimit = addSeconds(new Date(), 15);
    const subredditName = context.subredditName;

    const fiveMinutesAgo = subMinutes(new Date(), 5).getTime();

    // Prioritize users who were reclassified in the last 5 minutes, but also include any
    // users who were reclassified while this job was running to ensure no users are missed.
    const items = [
        ...await redis.zRange(RECLASSIFICATION_QUEUE, fiveMinutesAgo, Date.now(), { by: "score" }),
        ...await redis.zRange(RECLASSIFICATION_QUEUE, 0, fiveMinutesAgo - 1, { by: "score" }),
    ];

    const totalCount = await redis.zCard(RECLASSIFICATION_QUEUE);
    if (items.length === 0) {
        console.log("Classification Update: No users in reclassification queue.");
        return;
    } else if (!event.data.firstRun) {
        console.log(`Classification Update: Processing ${items.length} of ${totalCount} ${pluralize("user", totalCount)} in reclassification queue for ${subredditName}.`);
    }

    const appHasPermissions = await appAccountHasPermissions();

    const controlSubSettings = await getControlSubSettings();
    if (controlSubSettings.clientReclassificationDisabled) {
        console.log(`Classification Update: Client subreddit reclassification is disabled.`);
        return;
    }

    if (appHasPermissions && event.data.firstRun) {
        await reinstateItemsFromNoPermissionsQueue();
    }

    const appSettings = await settings.getAll();

    let processed = 0;

    while (items.length > 0 && new Date() < runLimit && processed < 50) {
        const item = items.shift();
        if (!item) {
            break;
        }

        const username = item.member;
        const currentStatus = await getUserStatus(username);

        const status = effectiveStatus(currentStatus);

        if (appHasPermissions) {
            await handleReclassificationWithPermissions(username, status, subredditName, appSettings, controlSubSettings);
        } else {
            await handleReclassificationWithoutPermissions(username, status);
        }

        await redis.zRem(RECLASSIFICATION_QUEUE, [username]);
        processed++;
    }

    if (items.length > 0) {
        await scheduler.runJob<HandleClassificationChangesData>({
            name: ClientSubredditJob.HandleClassificationChanges,
            runAt: addSeconds(new Date(), 5),
            data: { firstRun: false, jobGuid: crypto.randomUUID() },
        });
    } else {
        console.log(`Classification Update: All ${processed} ${pluralize("user", processed)} in reclassification queue processed.`);
        await redis.del(recentlyRunKey);
    }
}

const APP_PERMISSIONS_CACHE_KEY = "AppPermissionsCheckCache";

async function appAccountHasPermissions (): Promise<boolean> {
    const cachedResult = await redis.get(APP_PERMISSIONS_CACHE_KEY);
    if (cachedResult !== undefined) {
        return JSON.parse(cachedResult) as boolean;
    }

    const hasPerms = await hasPermissions({
        subredditName: context.subredditName,
        username: context.appSlug,
        requiredPerms: ["access", "posts"],
    });

    await redis.set(APP_PERMISSIONS_CACHE_KEY, JSON.stringify(hasPerms), { expiration: addDays(new Date(), 1) });
    return hasPerms;
}

export async function clearAppPermissionsCache () {
    await redis.del(APP_PERMISSIONS_CACHE_KEY);
}

function getUserContentCreationKey (username: string): string {
    return `userCreatedContentRecently:${username}`;
}

const IN_GRACE_PERIOD_KEY = "InContentCreationGracePeriod";

export async function recordUserContentCreation (username: string) {
    await redis.set(getUserContentCreationKey(username), "", { expiration: addDays(new Date(), 7) });
}

async function hasUserCreatedContentRecently (username: string): Promise<boolean> {
    return redis.exists(getUserContentCreationKey(username), IN_GRACE_PERIOD_KEY).then(exists => exists !== 0);
}

export async function storeRecordOfContentCreationGracePeriod () {
    const gracePeriodStoredKey = "ContentCreationGracePeriodStored";
    if (await redis.exists(gracePeriodStoredKey)) {
        return;
    }

    await redis.set(IN_GRACE_PERIOD_KEY, "true", { expiration: addDays(new Date(), 7) });
    await redis.set(gracePeriodStoredKey, "true");
}

const MODQUEUE_REMOVAL_STORE = "ModqueueRemovalStore";

export async function addUserToModqueueRemovalStore (username: string) {
    await redis.zAdd(MODQUEUE_REMOVAL_STORE, { member: username, score: new Date().getTime() });
}

export async function processModqueueRemovalStore () {
    const removalQueue = await redis.zRange(MODQUEUE_REMOVAL_STORE, 0, -1);
    if (removalQueue.length === 0) {
        return;
    }

    const appSettings = await settings.getAll();
    const action = appSettings[AppSetting.Action] as ActionType[] | undefined ?? [ActionType.Ban];
    if (!appSettings[AppSetting.RemoveFromModqueueWhenBanning] || !action.includes(ActionType.Ban)) {
        await redis.zRem(MODQUEUE_REMOVAL_STORE, removalQueue.map(item => item.member));
        console.log("Modqueue Removal: Setting to remove from modqueue when banning is disabled, skipping processing of modqueue removal store.");
        return;
    }

    const usersToCheck = new Set(removalQueue.map(item => item.member));

    const modQueue = await reddit.getModQueue({
        subreddit: context.subredditName,
        type: "all",
        limit: 1000,
    }).all();

    const itemsToRemove = modQueue.filter(item => usersToCheck.has(item.authorName));
    await Promise.all(itemsToRemove.map(item => item.remove()));
    await redis.zRem(MODQUEUE_REMOVAL_STORE, removalQueue.map(item => item.member));

    console.log(`Modqueue Removal: Removed ${itemsToRemove.length} ${pluralize("item", itemsToRemove.length)} from modqueue for ${usersToCheck.size} ${pluralize("user", usersToCheck.size)}.`);
}
