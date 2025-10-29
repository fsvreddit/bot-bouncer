import { Devvit, FormField } from "@devvit/public-api";
import { updateWikiPage } from "./dataStore.js";
import { ClientSubredditJob, CONTROL_SUBREDDIT, ControlSubredditJob, UniversalJob } from "./constants.js";
import { handleInstallOrUpgrade } from "./installActions.js";
import { handleControlSubFlairUpdate } from "./handleControlSubFlairUpdate.js";
import { appSettings } from "./settings.js";
import { cleanupDeletedAccounts } from "./cleanup.js";
import { handleConfigWikiChange, handleModAction, notifyModTeamOnDemod } from "./handleModAction.js";
import { handleModmail } from "./modmail/modmail.js";
import { handleControlSubAccountEvaluation } from "./handleControlSubAccountEvaluation.js";
import { handleReportUser, queryFormDefinition, queryFormHandler, reportFormDefinition, reportFormHandler } from "./handleReportUser.js";
import { handleClientCommentUpdate } from "./handleClientPostOrComment.js";
import { handleClassificationChanges, queueRecentReclassifications } from "./handleClientSubredditClassificationChanges.js";
import { handleControlSubPostDelete } from "./handleControlSubPostDelete.js";
import { updateEvaluatorVariablesFromWikiHandler } from "./userEvaluation/evaluatorVariables.js";
import { evaluateKarmaFarmingSubs, queueKarmaFarmingSubs } from "./karmaFarmingSubsCheck.js";
import { controlSubQuerySubmissionFormDefinition, handleControlSubForm, sendQueryToSubmitter } from "./handleControlSubMenu.js";
import { checkForUpdates } from "./upgradeNotifier.js";
import { sendDailyDigest } from "./modmail/dailyDigest.js";
import { perform6HourlyJobs, perform6HourlyJobsPart2 } from "./sixHourlyJobs.js";
import { checkUptimeAndMessages } from "./uptimeMonitor.js";
import { analyseBioText } from "./similarBioTextFinder/bioTextFinder.js";
import { handleRapidJob } from "./handleRapidJob.js";
import { buildEvaluatorAccuracyStatistics } from "./statistics/evaluatorAccuracyStatistics.js";
import { gatherDefinedHandlesStats, storeDefinedHandlesDataJob } from "./statistics/definedHandlesStatistics.js";
import { deleteRecordsForRemovedUsers, evaluatorReversalsJob } from "./evaluatorReversals.js";
import { handleCommentCreate, handlePostCreate } from "./handleContentCreation.js";
import { conditionalStatsUpdate } from "./statistics/conditionalStatsUpdate.js";
import { asyncWikiUpdate } from "./statistics/asyncWikiUpdate.js";
import { generateBioStatisticsReport, updateBioStatisticsJob } from "./statistics/userBioStatistics.js";
import { continueDataExtract } from "./modmail/dataExtract.js";

Devvit.addSettings(appSettings);

Devvit.addTrigger({
    events: ["AppInstall", "AppUpgrade"],
    onEvent: handleInstallOrUpgrade,
});

Devvit.addTrigger({
    event: "PostCreate",
    onEvent: handlePostCreate,
});

Devvit.addTrigger({
    event: "CommentCreate",
    onEvent: handleCommentCreate,
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
    onEvent: handleControlSubPostDelete,
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

export const reportForm = Devvit.createForm(reportFormDefinition, reportFormHandler);

export const queryForm = Devvit.createForm(queryFormDefinition, queryFormHandler);

export const controlSubForm = Devvit.createForm(data => ({ title: data.title as string, description: data.description as string, fields: data.fields as FormField[] }), handleControlSubForm);

export const controlSubQuerySubmissionForm = Devvit.createForm(controlSubQuerySubmissionFormDefinition, sendQueryToSubmitter);

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
    name: ControlSubredditJob.RapidJob,
    onRun: handleRapidJob,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.Perform6HourlyJobs,
    onRun: perform6HourlyJobs,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.Perform6HourlyJobsPart2,
    onRun: perform6HourlyJobsPart2,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.QueueKarmaFarmingSubs,
    onRun: queueKarmaFarmingSubs,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.EvaluateKarmaFarmingSubs,
    onRun: evaluateKarmaFarmingSubs,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.UpdateEvaluatorVariables,
    onRun: updateEvaluatorVariablesFromWikiHandler,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.UptimeAndMessageCheck,
    onRun: checkUptimeAndMessages,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.BioTextAnalyser,
    onRun: analyseBioText,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.EvaluatorAccuracyStatistics,
    onRun: buildEvaluatorAccuracyStatistics,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.DefinedHandlesStatistics,
    onRun: gatherDefinedHandlesStats,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.DefinedHandlesPostStore,
    onRun: storeDefinedHandlesDataJob,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.EvaluatorReversals,
    onRun: evaluatorReversalsJob,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.DeleteRecordsForRemovedUsers,
    onRun: deleteRecordsForRemovedUsers,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.HandleConfigWikiChange,
    onRun: handleConfigWikiChange,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.ConditionalStatsUpdate,
    onRun: conditionalStatsUpdate,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.AsyncWikiUpdate,
    onRun: asyncWikiUpdate,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.BioStatsUpdate,
    onRun: updateBioStatisticsJob,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.BioStatsGenerateReport,
    onRun: generateBioStatisticsReport,
});

Devvit.addSchedulerJob({
    name: ControlSubredditJob.DataExtractJob,
    onRun: continueDataExtract,
});

/**
 * Jobs that run on client subreddits only
 */

Devvit.addSchedulerJob({
    name: ClientSubredditJob.QueueReclassificationChanges,
    onRun: queueRecentReclassifications,
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

Devvit.addSchedulerJob({
    name: ClientSubredditJob.NotifyModTeamOnDemod,
    onRun: notifyModTeamOnDemod,
});

Devvit.configure({
    redditAPI: true,
    redis: true,
    http: true,
});

export default Devvit;
