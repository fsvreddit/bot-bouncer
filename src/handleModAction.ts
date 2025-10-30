import { JobContext, JSONObject, ScheduledJobEvent, TriggerContext } from "@devvit/public-api";
import { ModAction } from "@devvit/protos";
import { ClientSubredditJob, CONTROL_SUBREDDIT, ControlSubredditJob, INTERNAL_BOT } from "./constants.js";
import { recordWhitelistUnban, removeRecordOfBan } from "./handleClientSubredditClassificationChanges.js";
import { handleExternalSubmissionsPageUpdate } from "./externalSubmissions.js";
import { getControlSubSettings, validateControlSubConfigChange } from "./settings.js";
import { addDays, addMinutes, addSeconds } from "date-fns";
import { validateAndSaveAppealConfig } from "./modmail/autoAppealHandling.js";
import { checkIfStatsNeedUpdating } from "./sixHourlyJobs.js";
import { handleBannedSubredditsModAction } from "./statistics/bannedSubreddits.js";
import { isModerator, replaceAll, sendMessageToWebhook } from "./utility.js";

export async function handleModAction (event: ModAction, context: TriggerContext) {
    if (context.subredditName === CONTROL_SUBREDDIT) {
        await handleModActionControlSub(event, context);
    } else {
        await handleModActionClientSub(event, context);
    }
}

async function handleModActionClientSub (event: ModAction, context: TriggerContext) {
    if (!event.action) {
        return;
    }

    /**
     * If a user is unbanned on a client subreddit, remove the record of their ban.
     */
    if (event.action === "unbanuser" && event.moderator?.name !== context.appName && event.targetUser) {
        await removeRecordOfBan(event.targetUser.name, context.redis);
        await recordWhitelistUnban(event.targetUser.name, context);
    }

    /**
     * If Automod, Reddit or a mod removes a post or comment, ensure that the record of the comment being
     * stored for potential reapproval is removed. While normally the "spam" property should already
     * be set when the CommentCreate or PostCreate trigger is fired, this is a failsafe.
     */
    const actions = ["removecomment", "removelink", "spamcomment", "spamlink"];
    if (actions.includes(event.action) && event.moderator?.name !== context.appName && event.targetUser) {
        await context.redis.del(`removed:${event.targetUser.name}`);
        let targetId: string | undefined;
        if (event.action === "removecomment" || event.action === "spamcomment") {
            targetId = event.targetComment?.id;
        } else {
            targetId = event.targetPost?.id;
        }
        if (targetId) {
            await context.redis.hDel(`removedItems:${event.targetUser.name}`, [targetId]);
            await context.redis.set(`removedbymod:${targetId}`, "true", { expiration: addDays(new Date(), 28) });
        }
    }

    if (event.action === "removemoderator" && event.targetUser?.name === context.appName) {
        // Bot Bouncer has been demodded - notify the mod team after one minute.
        // This delay allows for intentional uninstalls to proceed without the notification.
        await context.scheduler.runJob({
            name: ClientSubredditJob.NotifyModTeamOnDemod,
            runAt: addMinutes(new Date(), 1),
            data: { modName: event.moderator?.name ? `u/${event.moderator.name}` : "A moderator" },
        });

        console.warn(`handleModActionClientSub: Bot Bouncer has been removed as a moderator from r/${context.subredditName} by u/${event.moderator?.name}`);
    }

    // Special actions for observer subreddits
    if (event.action === "wikirevise" && event.moderator?.name.startsWith(context.appName) && event.moderator.name !== context.appName && event.moderator.name !== INTERNAL_BOT) {
        await handleBannedSubredditsModAction(event, context);
        await handleExternalSubmissionsPageUpdate(context);
    }
}

enum ConfigWikiPage {
    AutoAppealHandling = "autoAppealHandling",
    ControlSubSettings = "controlSubSettings",
}

async function handleModActionControlSub (event: ModAction, context: TriggerContext) {
    /**
     * When the wiki gets revised on the control subreddit, it may be because another
     * subreddit has filed in an external submission. Handle that eventuality.
     *
     * It may also be because the control sub configuration has changed, in which case
     * check that too.
     */
    if (event.action === "wikirevise" && event.moderator) {
        if (event.moderator.name === context.appName || event.moderator.name === INTERNAL_BOT) {
            await handleExternalSubmissionsPageUpdate(context);
        }

        if (event.moderator.name === INTERNAL_BOT) {
            await checkIfStatsNeedUpdating(context);
        }

        if (event.moderator.name !== context.appName && event.moderator.name !== INTERNAL_BOT) {
            await Promise.all([
                context.scheduler.runJob({
                    name: ControlSubredditJob.UpdateEvaluatorVariables,
                    runAt: new Date(),
                    data: { username: event.moderator.name },
                }),

                queueConfigWikiCheck(ConfigWikiPage.ControlSubSettings, 10, context),
                queueConfigWikiCheck(ConfigWikiPage.AutoAppealHandling, 20, context),
            ]);
        }
    }

    /**
     * When a link is approved on the control subreddit, check to see if it's a post from a non-mod.
     * If so, alert on Discord.
     */
    if (event.action === "approvelink" && event.moderator?.name !== context.appName && event.targetPost) {
        const post = await context.reddit.getPostById(event.targetPost.id);
        if (await isModerator(post.authorName, context)) {
            return;
        }

        const controlSubSettings = await getControlSubSettings(context);
        if (!controlSubSettings.monitoringWebhook) {
            return;
        }

        const message = `A post by a non-mod has been approved on r/${CONTROL_SUBREDDIT}. This may be a mistake.\n\n`
            + `[${post.title}](https://www.reddit.com${post.permalink}) by u/${post.authorName}`;

        await sendMessageToWebhook(controlSubSettings.monitoringWebhook, message);
    }

    if (event.action === "removelink" && event.moderator?.name !== context.appName && event.targetPost) {
        const post = await context.reddit.getPostById(event.targetPost.id);
        if (post.authorName !== context.appName) {
            return;
        }

        const controlSubSettings = await getControlSubSettings(context);
        if (!controlSubSettings.monitoringWebhook) {
            return;
        }

        const message = `A post by Bot Bouncer has been removed on r/${CONTROL_SUBREDDIT}. This may be a mistake.\n\n`
            + `[${post.title}](https://www.reddit.com${post.permalink})`;

        await sendMessageToWebhook(controlSubSettings.monitoringWebhook, message);
    }
}

async function queueConfigWikiCheck (configWikiPage: ConfigWikiPage, delay: number, context: JobContext) {
    const redisKey = `configWikiQueued:${configWikiPage}`;
    const alreadyQueued = await context.redis.exists(redisKey);
    if (alreadyQueued) {
        console.log(`handleConfigWikiChange: Another job is already queued for ${configWikiPage}, skipping this run.`);
        return;
    }

    await context.redis.set(redisKey, "true", { expiration: addMinutes(new Date(), 1) });

    await context.scheduler.runJob({
        name: ControlSubredditJob.HandleConfigWikiChange,
        runAt: addSeconds(new Date(), delay),
        data: { page: configWikiPage },
    });
}

export async function handleConfigWikiChange (event: ScheduledJobEvent<JSONObject>, context: JobContext) {
    const configWikiPage = event.data.page as ConfigWikiPage;
    const redisKey = `configWikiQueued:${configWikiPage}`;

    switch (configWikiPage) {
        case ConfigWikiPage.AutoAppealHandling:
            await validateAndSaveAppealConfig(context.appName, context);
            break;
        case ConfigWikiPage.ControlSubSettings:
            await validateControlSubConfigChange(context.appName, context);
            break;
        default:
            console.error(`handleConfigWikiChange: Unknown config wiki page: ${configWikiPage}`);
    }

    await context.redis.del(redisKey);
}

export async function notifyModTeamOnDemod (event: ScheduledJobEvent<JSONObject | undefined>, context: JobContext) {
    const notificationDoneKey = "demodNotificationSent";
    const alreadyNotified = await context.redis.exists(notificationDoneKey);
    if (alreadyNotified) {
        console.log("notifyModTeamOnDemod: Notification already sent, skipping.");
        return;
    }

    const subredditName = context.subredditName ?? await context.reddit.getCurrentSubredditName();

    const moderators = await context.reddit.getModerators({
        subredditName,
        username: context.appName,
    }).all();

    if (moderators.length > 0) {
        console.log(`notifyModTeamOnDemod: Still a moderator of r/${subredditName}, no notification sent.`);
        return; // Still a mod, no action needed
    }

    const modName = event.data?.modName as string | undefined ?? "A moderator";
    const controlSubSettings = await getControlSubSettings(context);

    let message = controlSubSettings.appRemovedMessage;
    if (!message) {
        console.log(`notifyModTeamOnDemod: No app removed message configured for r/${subredditName}, no notification sent.`);
        return;
    }

    message = replaceAll(message, "{modName}", modName);
    message = replaceAll(message, "{subredditName}", subredditName);

    message += "\n\n*This message was sent automatically, replies will not be read.*";

    await context.reddit.sendPrivateMessage({
        to: `/r/${subredditName}`,
        subject: "Bot Bouncer has been removed as a moderator",
        text: message,
    });

    console.log(`notifyModTeamOnDemod: Notified r/${subredditName} mod team of Bot Bouncer removal.`);
    await context.redis.set(notificationDoneKey, "true");
}
