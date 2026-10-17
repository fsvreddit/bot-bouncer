import { reddit, redis, scheduler, TaskRequest } from "@devvit/web/server";
import { UserStatus } from "@fsvreddit/bot-bouncer-types";
import { CONTROL_SUBREDDIT, ControlSubredditJob, getControlSubSettings, getUserStatus, UserDetails } from "..";
import { hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import pluralize from "pluralize";
import { addMinutes, addSeconds } from "date-fns";
import { RecoveredAccountsData } from "../../tasks";
import { CompiledAppealConfig, getAppealConfig, getMatchedAppealConfig } from "./modmail";
import _ from "lodash";

const RECOVERED_RECHECKS_QUEUE_KEY = "recoveredRechecksQueue";
const RECOVERED_RECHECKS_RECOVERED_KEY = "recoveredRechecksRecovered";

export async function addUserToRecoveredRechecksQueue (username: string, userDetails: UserDetails) {
    if (userDetails.userStatus !== UserStatus.Banned) {
        return;
    }

    await redis.zAdd(RECOVERED_RECHECKS_QUEUE_KEY, { member: username, score: Date.now() });
}

async function getHackedAppealConfigs (): Promise<CompiledAppealConfig[]> {
    const appealConfigs = await getAppealConfig();
    return appealConfigs.filter(config => config.isHackedAppealConfig && config.setStatus === "recovered");
}

async function checkAndHandleAccountIsRecovered (username: string, appealConfigs: CompiledAppealConfig[]) {
    const userDetails = await getUserStatus(username);
    if (userDetails?.userStatus !== UserStatus.Banned) {
        await redis.zRem(RECOVERED_RECHECKS_QUEUE_KEY, [username]);
        return;
    }

    let matchingAppealConfig: CompiledAppealConfig | undefined;
    try {
        matchingAppealConfig = await getMatchedAppealConfig(username, userDetails, appealConfigs, undefined);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Recovered Accounts: Error checking appeal config for ${username}: ${errorMessage}`);
        await redis.zRem(RECOVERED_RECHECKS_QUEUE_KEY, [username]);
        return;
    }

    if (matchingAppealConfig?.setStatus === "recovered") {
        console.log(`Recovered Accounts: 😁 User ${username} has been identified as recovered: ${matchingAppealConfig.name}`);
        if (userDetails.trackingPostId !== "") {
            await reddit.setPostFlair({
                subredditName: CONTROL_SUBREDDIT,
                postId: userDetails.trackingPostId,
                text: "recovered",
            });
            const newCount = await redis.incrBy(RECOVERED_RECHECKS_RECOVERED_KEY, 1);
            console.log(`Recovered Accounts: User ${username} has been marked as recovered. ${newCount} accounts handled now.`);
        } else {
            console.warn(`Recovered Accounts: User ${username} has no tracking post ID. Cannot update status to recovered.`);
        }
    }

    await redis.zRem(RECOVERED_RECHECKS_QUEUE_KEY, [username]);
}

export async function checkPotentiallyRecoveredAccounts (event: TaskRequest<RecoveredAccountsData>) {
    const recoveredAccountsToCheck = await redis.zRange(RECOVERED_RECHECKS_QUEUE_KEY, 0, -1);
    if (recoveredAccountsToCheck.length === 0) {
        return;
    }

    const controlSubSettings = await getControlSubSettings();
    if (!controlSubSettings.autoAccountRecoveryEnabled) {
        console.log("Recovered Accounts: Auto account recovery is disabled in the control subreddit settings. Skipping this run.");
        return;
    }

    const jobRunRecentlyKey = "recoveredAccountsJobRunRecently";

    if (event.data.firstRun) {
        if (await redis.exists(jobRunRecentlyKey)) {
            console.log("Recovered Accounts: Job has run recently. Skipping this run.");
            return;
        }

        console.log(`Recovered Accounts: Starting job. Checking ${recoveredAccountsToCheck.length} ${pluralize("account", recoveredAccountsToCheck.length)} for recovery.`);
    }

    if (await hasEventBeenHandled(`job:${event.data.jobGuid}`)) {
        console.log(`Recovered Accounts: Job ${event.data.jobGuid} has already been handled. Skipping this run.`);
        return;
    }

    await redis.set(jobRunRecentlyKey, Date.now().toString(), { expiration: addMinutes(new Date(), 1) });

    const appealConfigs = await getHackedAppealConfigs();
    if (appealConfigs.length === 0) {
        console.log("Recovered Accounts: No hacked appeal configs found. Skipping this run.");
        return;
    }

    const runLimit = addSeconds(new Date(), 15);
    let processed = 0;

    const chunks = _.chunk(recoveredAccountsToCheck, 10);

    while (chunks.flat().length > 0 && new Date() < runLimit) {
        const firstChunk = chunks.shift();
        if (!firstChunk) {
            break;
        }

        await Promise.all(firstChunk.map(async (entry) => {
            const username = entry.member;
            await checkAndHandleAccountIsRecovered(username, appealConfigs);
            processed++;
        }));
    }

    console.log(`Recovered Accounts: Processed ${processed} ${pluralize("account", processed)} for recovery, ${recoveredAccountsToCheck.length} remain in queue.`);

    if (recoveredAccountsToCheck.length > 0) {
        await scheduler.runJob<RecoveredAccountsData>({
            name: ControlSubredditJob.AutoAccountRecovery,
            runAt: addSeconds(new Date(), 5),
            data: {
                firstRun: false,
                jobGuid: crypto.randomUUID(),
            },
        });
    }
}
