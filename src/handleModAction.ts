import { JobContext, JSONObject, ScheduledJobEvent, TriggerContext } from "@devvit/public-api";
import { ModAction } from "@devvit/protos";
import { CONTROL_SUBREDDIT, ControlSubredditJob, INTERNAL_BOT, UniversalJob } from "./constants.js";
import { recordWhitelistUnban, removeRecordOfBan } from "./handleClientSubredditWikiUpdate.js";
import { handleExternalSubmissionsPageUpdate } from "./externalSubmissions.js";
import { validateControlSubConfigChange } from "./settings.js";
import { addDays, addMinutes, addSeconds } from "date-fns";
import { validateAndSaveAppealConfig } from "./modmail/autoAppealHandling.js";
import { checkIfStatsNeedUpdating } from "./sixHourlyJobs.js";

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
                    name: UniversalJob.UpdateEvaluatorVariables,
                    runAt: new Date(),
                    data: { username: event.moderator.name },
                }),

                queueConfigWikiCheck(ConfigWikiPage.AutoAppealHandling, 5, context),
                queueConfigWikiCheck(ConfigWikiPage.ControlSubSettings, 10, context),
            ]);
        }
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
