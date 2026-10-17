import { context, reddit, redis, scheduler } from "@devvit/web/server";
import { OnModActionRequest, T3, TriggerResponse } from "@devvit/web/shared";
import { getExtendedDevvit, hasEventBeenHandled } from "@fsvreddit/fsv-devvit-web-helpers";
import { addDays, addMinutes, addSeconds, subMinutes } from "date-fns";
import { Context } from "hono";
import { accountIsBotBouncerApp, APP_ACCOUNT_ID, clearAppPermissionsCache, ClientSubredditJob, ConfigWikiPage, CONTROL_SUBREDDIT, ControlSubredditJob, getControlSubSettings, getInstallDate, handleExternalSubmissionsPageUpdate, INTERNAL_BOT, isModeratorWithCache, recordWhitelistUnban, removeCachedBanStatus, removeRecordOfBan, sendMessageToWebhook } from "../core";
import { HandleConfigWikiChangeRequestData, UpdateEvaluatorVariablesFromWikiEventData } from "../tasks";
import { SixHourlyJobData } from "../tasks/handleSixHourlyJobs";
import { handleObserverSubsWikiPageCopy } from "../core/controlSubCore/statistics";

export const onModAction = async (c: Context): Promise<Response> => {
    const event = await c.req.json<OnModActionRequest>();

    if (await hasEventBeenHandled(`ModAction:${event.action}:${event.moderator?.name}:${event.actionedAt}`, { expiration: addMinutes(new Date(), 10) })) {
        return c.json<TriggerResponse>({ message: "Trigger has already been handled." }, 200);
    }

    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleModActionControlSub(event);
    } else {
        await handleModActionClientSub(event);
    }

    return c.json<TriggerResponse>({ message: "Trigger handled successfully." }, 200);
};

async function handleModActionClientSub (event: OnModActionRequest) {
    if (!event.action) {
        return;
    }

    /**
     * If a user is unbanned on a client subreddit, remove the record of their ban.
     */
    if (event.action === "unbanuser" && event.moderator?.name !== context.appSlug && event.targetUser) {
        await removeRecordOfBan(event.targetUser.name);
        await recordWhitelistUnban(event.targetUser.name);
    }

    /**
     * If Automod, Reddit or a mod removes a post or comment, ensure that the record of the comment being
     * stored for potential reapproval is removed. While normally the "spam" property should already
     * be set when the CommentCreate or PostCreate trigger is fired, this is a failsafe.
     */
    const actions = ["removecomment", "removelink", "spamcomment", "spamlink"];
    if (actions.includes(event.action) && event.moderator?.name && event.moderator.name !== context.appSlug && event.targetUser) {
        await redis.del(`removed:${event.targetUser.name}`);
        let targetId: string | undefined;
        if (event.action === "removecomment" || event.action === "spamcomment") {
            targetId = event.targetComment?.id;
        } else {
            targetId = event.targetPost?.id;
        }
        if (targetId) {
            await redis.hDel(`removedItems:${event.targetUser.name}`, [targetId]);
            await redis.set(`removedbymod:${targetId}`, event.moderator.name, { expiration: addDays(new Date(), 28) });
        }
    }

    if (event.action === "removemoderator" && event.targetUser?.name === context.appSlug) {
        // Bot Bouncer has been demodded - notify the mod team after one minute.
        // This delay allows for intentional uninstalls to proceed without the notification.
        await scheduler.runJob({
            name: ClientSubredditJob.NotifyModTeamOnDemod,
            runAt: addMinutes(new Date(), 1),
            data: {
                modName: event.moderator?.name ? `u/${event.moderator.name}` : "A moderator",
                jobGuid: crypto.randomUUID(),
            },
        });

        console.warn(`handleModActionClientSub: Bot Bouncer has been removed as a moderator from r/${context.subredditName} by u/${event.moderator?.name}`);
    }

    if (event.action === "invitemoderator" && event.targetUser?.name === context.appSlug) {
        // Bot Bouncer has been re-invited as a mod. Accept the invitation.
        const installDate = await getInstallDate();
        if (!installDate) {
            console.error("handleModActionClientSub: Cannot accept moderator invite as install date is not set.");
            return;
        }

        if (installDate > subMinutes(new Date(), 1)) {
            console.log("handleModActionClientSub: Moderator invite ignored as install date is very recent. Don't want to interfere with initial install.");
            return;
        }

        await getExtendedDevvit().redditAPIPlugins.Moderation.AcceptModeratorInvite({
            subreddit: context.subredditName,
        });
        console.log(`handleModActionClientSub: Bot Bouncer has been re-invited as a moderator to r/${context.subredditName} by u/${event.moderator?.name}`);
    }

    if (event.action === "setpermissions" && event.targetUser?.name === context.appSlug) {
        await clearAppPermissionsCache();
        console.log(`handleModActionClientSub: Bot Bouncer's moderator permissions have been changed on r/${context.subredditName} by u/${event.moderator?.name}`);
    }

    // Special actions for observer subreddits
    if (event.action === "wikirevise" && event.moderator?.name && event.moderator.name !== context.appSlug && event.moderator.name !== INTERNAL_BOT && await accountIsBotBouncerApp(event.moderator.name)) {
        await handleObserverSubsWikiPageCopy();
        await handleExternalSubmissionsPageUpdate();
    }
}

async function handleModActionControlSub (event: OnModActionRequest) {
    /**
     * When the wiki gets revised on the control subreddit, it may be because another
     * subreddit has filed in an external submission. Handle that eventuality.
     *
     * It may also be because the control sub configuration has changed, in which case
     * check that too.
     */
    if (event.action === "wikirevise" && event.moderator) {
        if (event.moderator.name === context.appSlug || event.moderator.name === INTERNAL_BOT) {
            await handleExternalSubmissionsPageUpdate();
        }

        if (event.moderator.name === INTERNAL_BOT) {
            await checkIfStatsNeedUpdating();
        }

        if (event.moderator.name !== context.appSlug && event.moderator.name !== INTERNAL_BOT) {
            const jobData: UpdateEvaluatorVariablesFromWikiEventData = {
                username: event.moderator.name,
                jobGuid: crypto.randomUUID(),
            };

            if (event.actionedAt) {
                jobData.actionedAt = new Date(event.actionedAt).getTime();
            }

            await Promise.all([
                scheduler.runJob<UpdateEvaluatorVariablesFromWikiEventData>({
                    name: ControlSubredditJob.UpdateEvaluatorVariables,
                    runAt: new Date(),
                    data: jobData,
                }),

                queueConfigWikiCheck(ConfigWikiPage.AutoAppealHandling, event.moderator.name, 1),
                queueConfigWikiCheck(ConfigWikiPage.ControlSubSettings, event.moderator.name, 1),
            ]);
        }

        await redis.del("aiPromptCache");
    }

    /**
     * When a link is approved on the control subreddit, check to see if it's a post from a non-mod.
     * If so, alert on Discord.
     */
    if (event.action === "approvelink" && event.moderator?.name !== context.appSlug && event.targetPost) {
        const post = await reddit.getPostById(event.targetPost.id as T3);
        if (await isModeratorWithCache(post.authorName)) {
            return;
        }

        const controlSubSettings = await getControlSubSettings();
        if (!controlSubSettings.monitoringWebhook) {
            return;
        }

        const message = `A post by a non-mod has been approved on r/${CONTROL_SUBREDDIT} by ${event.moderator?.name ?? "an unknown moderator"}. This may be a mistake.\n\n`
            + `[${post.title}](https://www.reddit.com${post.permalink}) by u/${post.authorName}`;

        await sendMessageToWebhook(controlSubSettings.monitoringWebhook, message);
    }

    if (event.action === "removelink" && event.moderator?.name !== context.appSlug && event.targetPost) {
        const post = await reddit.getPostById(event.targetPost.id as T3);
        if (post.authorName !== context.appSlug) {
            return;
        }

        const controlSubSettings = await getControlSubSettings();
        if (!controlSubSettings.monitoringWebhook) {
            return;
        }

        const message = `A post by Bot Bouncer has been removed on r/${CONTROL_SUBREDDIT} by ${event.moderator?.name ?? "an unknown moderator"}. This may be a mistake.\n\n`
            + `[${post.title}](https://www.reddit.com${post.permalink})`;

        await sendMessageToWebhook(controlSubSettings.monitoringWebhook, message);
    }

    if ((event.action === "banuser" || event.action === "unbanuser") && event.targetUser) {
        await removeCachedBanStatus(event.targetUser.name);
    }
}

async function queueConfigWikiCheck (configWikiPage: ConfigWikiPage, updatedBy: string, delay: number) {
    const redisKey = `configWikiQueued:${configWikiPage}`;
    const alreadyQueued = await redis.exists(redisKey);
    if (alreadyQueued) {
        console.log(`handleConfigWikiChange: Another job is already queued for ${configWikiPage}, skipping this run.`);
        return;
    }

    await redis.set(redisKey, "true", { expiration: addMinutes(new Date(), 1) });

    await scheduler.runJob<HandleConfigWikiChangeRequestData>({
        name: ControlSubredditJob.HandleConfigWikiChange,
        runAt: addSeconds(new Date(), delay),
        data: {
            page: configWikiPage,
            updatedBy,
            jobGuid: crypto.randomUUID(),
        },
    });
}

async function checkIfStatsNeedUpdating () {
    const lastRevisionKey = "lastRemoteStatsUpdate";
    const lastRevisionVal = await redis.get(lastRevisionKey);
    const wikiPage = await reddit.getWikiPage(CONTROL_SUBREDDIT, "statistics/update_stats", {});
    if (lastRevisionVal === wikiPage.revisionId) {
        return;
    }

    if (wikiPage.revisionAuthorId === APP_ACCOUNT_ID) {
        return;
    }

    console.log("Stats wiki page has been updated, scheduling stats update job.");

    await scheduler.runJob<SixHourlyJobData>({
        name: ControlSubredditJob.Perform6HourlyJobs,
        runAt: new Date(),
        data: { jobGuid: crypto.randomUUID() },
    });

    const newEntry = await reddit.updateWikiPage({
        subredditName: CONTROL_SUBREDDIT,
        page: "statistics/update_stats",
        content: "false",
    });

    await redis.set(lastRevisionKey, newEntry.revisionId);
}
