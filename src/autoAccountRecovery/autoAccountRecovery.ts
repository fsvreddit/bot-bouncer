import { JobContext, ScheduledJobEvent } from "@devvit/public-api";
import { CompiledAppealConfig, getAppealConfig, getMatchedAppealConfig } from "../modmail/autoAppealHandling.js";
import { getUserStatus, UserDetails } from "../dataStore.js";
import { hasTriggerBeenHandled } from "@fsvreddit/fsv-devvit-helpers";
import { addMinutes, addSeconds } from "date-fns";
import { CONTROL_SUBREDDIT, ControlSubredditJob } from "../constants.js";
import { RecoveredAccountsData, UserStatus } from "../types.js";
import pluralize from "pluralize";
import { getControlSubSettings } from "../settings.js";
import { recordAppealHandled } from "../statistics/appealStatistics.js";

const RECOVERED_RECHECKS_QUEUE_KEY = "recoveredRechecksQueue";
const RECOVERED_RECHECKS_RECOVERED_KEY = "recoveredRechecksRecovered";

export async function addUserToRecoveredRechecksQueue (username: string, userDetails: UserDetails, context: JobContext) {
    if (userDetails.userStatus !== UserStatus.Banned) {
        return;
    }

    await context.redis.zAdd(RECOVERED_RECHECKS_QUEUE_KEY, { member: username, score: Date.now() });
}

async function getHackedAppealConfigs (context: JobContext): Promise<CompiledAppealConfig[]> {
    const appealConfigs = await getAppealConfig(context);
    return appealConfigs.filter(config => config.isHackedAppealConfig && config.setStatus === "recovered");
}

async function checkAndHandleAccountIsRecovered (username: string, appealConfigs: CompiledAppealConfig[], context: JobContext) {
    const userDetails = await getUserStatus(username, context);
    if (userDetails?.userStatus !== UserStatus.Banned) {
        await context.redis.zRem(RECOVERED_RECHECKS_QUEUE_KEY, [username]);
        return;
    }

    let matchingAppealConfig: CompiledAppealConfig | undefined;
    try {
        matchingAppealConfig = await getMatchedAppealConfig(username, userDetails, appealConfigs, undefined, context);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Recovered Accounts: Error checking appeal config for ${username}: ${errorMessage}`);
        await context.redis.zRem(RECOVERED_RECHECKS_QUEUE_KEY, [username]);
        return;
    }

    if (matchingAppealConfig?.setStatus === "recovered") {
        console.log(`Recovered Accounts: 😁 User ${username} has been identified as recovered: ${matchingAppealConfig.name}`);
        if (userDetails.trackingPostId !== "") {
            await context.reddit.setPostFlair({
                subredditName: CONTROL_SUBREDDIT,
                postId: userDetails.trackingPostId,
                text: "recovered",
            });
            const newCount = await context.redis.incrBy(RECOVERED_RECHECKS_RECOVERED_KEY, 1);
            await recordAppealHandled(context.appSlug, context);
            console.log(`Recovered Accounts: User ${username} has been marked as recovered. ${newCount} accounts handled now.`);
        } else {
            console.warn(`Recovered Accounts: User ${username} has no tracking post ID. Cannot update status to recovered.`);
        }
    }

    await context.redis.zRem(RECOVERED_RECHECKS_QUEUE_KEY, [username]);
}

export async function checkPotentiallyRecoveredAccounts (event: ScheduledJobEvent<RecoveredAccountsData>, context: JobContext) {
    const recoveredAccountsToCheck = await context.redis.zRange(RECOVERED_RECHECKS_QUEUE_KEY, 0, -1);
    if (recoveredAccountsToCheck.length === 0) {
        return;
    }

    const controlSubSettings = await getControlSubSettings(context);
    if (!controlSubSettings.autoAccountRecoveryEnabled) {
        console.log("Recovered Accounts: Auto account recovery is disabled in the control subreddit settings. Skipping this run.");
        return;
    }

    const jobRunRecentlyKey = "recoveredAccountsJobRunRecently";

    if (event.data.firstRun) {
        if (await context.redis.exists(jobRunRecentlyKey)) {
            console.log("Recovered Accounts: Job has run recently. Skipping this run.");
            return;
        }

        console.log(`Recovered Accounts: Starting job. Checking ${recoveredAccountsToCheck.length} ${pluralize("account", recoveredAccountsToCheck.length)} for recovery.`);
    }

    if (await hasTriggerBeenHandled(context.redis, `job:${event.data.jobGuid}`)) {
        console.log(`Recovered Accounts: Job ${event.data.jobGuid} has already been handled. Skipping this run.`);
        return;
    }

    await context.redis.set(jobRunRecentlyKey, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });

    const appealConfigs = await getHackedAppealConfigs(context);
    if (appealConfigs.length === 0) {
        console.log("Recovered Accounts: No hacked appeal configs found. Skipping this run.");
        return;
    }

    const runLimit = addSeconds(new Date(), 20);
    let processed = 0;

    while (recoveredAccountsToCheck.length > 0 && new Date() < runLimit) {
        const firstEntry = recoveredAccountsToCheck.shift();
        if (!firstEntry) {
            break;
        }

        const username = firstEntry.member;
        await checkAndHandleAccountIsRecovered(username, appealConfigs, context);
        processed++;
    }

    console.log(`Recovered Accounts: Processed ${processed} ${pluralize("account", processed)} for recovery, ${recoveredAccountsToCheck.length} remain in queue.`);

    if (recoveredAccountsToCheck.length > 0) {
        await context.scheduler.runJob({
            name: ControlSubredditJob.AutoAccountRecovery,
            runAt: addSeconds(new Date(), 5),
            data: {
                firstRun: false,
                jobGuid: crypto.randomUUID(),
            } satisfies RecoveredAccountsData,
        });
    }
}
