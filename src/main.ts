import { Devvit, FormField } from "@devvit/public-api";
import { handleControlSubSubmission } from "./handleControlSubSubmission.js";
import { updateLocalStoreFromWiki, updateWikiPage } from "./dataStore.js";
import { ClientSubredditJob, CONTROL_SUBREDDIT, ControlSubredditJob, UniversalJob } from "./constants.js";
import { handleInstallOrUpgrade } from "./installActions.js";
import { handleControlSubFlairUpdate } from "./handleControlSubFlairUpdate.js";
import { appSettings, copyControlSubSettingsToOldWiki } from "./settings.js";
import { cleanupDeletedAccounts } from "./cleanup.js";
import { handleModAction } from "./handleModAction.js";
import { handleModmail } from "./modmail/modmail.js";
import { handleControlSubAccountEvaluation } from "./handleControlSubAccountEvaluation.js";
import { handleReportUser, reportFormHandler } from "./handleReportUser.js";
import { processExternalSubmissions } from "./externalSubmissions.js";
import { handleClientCommentCreate, handleClientCommentUpdate, handleClientPostCreate } from "./handleClientPostOrComment.js";
import { handleClientSubCommentDelete, handleClientSubPostDelete } from "./handleClientSubContentDelete.js";
import { handleClassificationChanges } from "./handleClientSubredditWikiUpdate.js";
import { handleControlSubPostDelete } from "./handleControlSubPostDelete.js";
import { updateEvaluatorVariablesFromWikiHandler } from "./userEvaluation/evaluatorVariables.js";
import { evaluateKarmaFarmingSubs } from "./karmaFarmingSubsCheck.js";
import { handleControlSubForm } from "./handleControlSubMenu.js";
import { checkForUpdates } from "./upgradeNotifier.js";
import { sendDailyDigest } from "./modmail/dailyDigest.js";
import { updateStatisticsPages } from "./statistics/allStatistics.js";
import { checkUptimeAndMessages } from "./uptimeMonitor.js";
import { analyseBioText } from "./similarBioTextFinder/bioTextFinder.js";

Devvit.addSettings(appSettings);

Devvit.addTrigger({
    events: ["AppInstall", "AppUpgrade"],
    onEvent: handleInstallOrUpgrade,
});

Devvit.addTrigger({
    event: "PostCreate",
    onEvent: handleControlSubSubmission,
});

Devvit.addTrigger({
    event: "PostCreate",
    onEvent: handleClientPostCreate,
});

Devvit.addTrigger({
    event: "CommentCreate",
    onEvent: handleClientCommentCreate,
});

Devvit.addTrigger({
    event: "CommentUpdate",
    onEvent: handleClientCommentUpdate,
});

Devvit.addTrigger({
    event: "PostFlairUpdate",
    onEvent: handleControlSubFlairUpdate,
});

Devvit.addTrigger({
    event: "PostDelete",
    onEvent: handleClientSubPostDelete,
});

Devvit.addTrigger({
    event: "PostDelete",
    onEvent: handleControlSubPostDelete,
});

Devvit.addTrigger({
    event: "CommentDelete",
    onEvent: handleClientSubCommentDelete,
});

Devvit.addTrigger({
    event: "ModAction",
    onEvent: handleModAction,
});

Devvit.addTrigger({
    event: "ModMail",
    onEvent: handleModmail,
});

Devvit.addMenuItem({
    label: "Report User to Bot Bouncer",
    location: "comment",
    forUserType: "moderator",
    description: `Creates a report on /r/${CONTROL_SUBREDDIT}`,
    onPress: handleReportUser,
});

Devvit.addMenuItem({
    label: "Report User to Bot Bouncer",
    location: "post",
    forUserType: "moderator",
    description: `Creates a report on /r/${CONTROL_SUBREDDIT}`,
    onPress: handleReportUser,
});

export const reportForm = Devvit.createForm({
    fields: [
        {
            type: "paragraph",
            label: "Optional. Please provide more information that might help us understand why this is a bot",
            helpText: "This is in case it is not obvious that this is a LLM bot.",
            lineHeight: 4,
            name: "reportContext",
        },
        {
            type: "boolean",
            label: "Show the above text publicly on the post on r/BotBouncer. Your username will be kept private.",
            defaultValue: true,
            name: "publicContext",
        },
    ],
}, reportFormHandler);

export const controlSubForm = Devvit.createForm(data => ({ title: data.title as string, description: data.description as string, fields: data.fields as FormField[] }), handleControlSubForm);

/**
 * Jobs that run on all subreddits
 */

Devvit.addSchedulerJob({
    name: UniversalJob.Cleanup,
    onRun: cleanupDeletedAccounts,
});

Devvit.addSchedulerJob({
    name: UniversalJob.AdhocCleanup,
    onRun: cleanupDeletedAccounts,
});

/**
 * Jobs that run on the control subreddit only
 */

Devvit.addSchedulerJob({
    name: ControlSubredditJob.UpdateWikiPage,
    onRun: updateWikiPage,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.EvaluateUser,
    onRun: handleControlSubAccountEvaluation,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.ExternalSubmission,
    onRun: processExternalSubmissions,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.UpdateStatisticsPage,
    onRun: updateStatisticsPages,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.EvaluateKarmaFarmingSubs,
    onRun: evaluateKarmaFarmingSubs,
});

Devvit.addSchedulerJob({
    name: UniversalJob.UpdateEvaluatorVariables,
    onRun: updateEvaluatorVariablesFromWikiHandler,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.CopyControlSubSettings,
    onRun: copyControlSubSettingsToOldWiki,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.UptimeAndMessageCheck,
    onRun: checkUptimeAndMessages,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.BioTextAnalyser,
    onRun: analyseBioText,
});

/**
 * Jobs that run on client subreddits only
 */

Devvit.addSchedulerJob({
    name: ClientSubredditJob.UpdateDatastoreFromWiki,
    onRun: updateLocalStoreFromWiki,
});

Devvit.addSchedulerJob({
    name: ClientSubredditJob.HandleClassificationChanges,
    onRun: handleClassificationChanges,
});

Devvit.addSchedulerJob({
    name: ClientSubredditJob.UpgradeNotifier,
    onRun: checkForUpdates,
});

Devvit.addSchedulerJob({
    name: ClientSubredditJob.SendDailyDigest,
    onRun: sendDailyDigest,
});

Devvit.configure({
    redditAPI: true,
    redis: true,
    http: true,
});

export default Devvit;
