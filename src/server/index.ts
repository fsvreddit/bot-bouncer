import { Hono } from "hono";
import { createServer, getServerPort } from "@devvit/web/server";
import { getRequestListener } from "@hono/node-server";
import { handleSelectFieldHasOptionChosen } from "./validators";
import { onAppInstall, onAppUpgrade, onCommentCreate, onCommentUpdate, onModAction, onModMail, onPostCreate, onPostDelete, onPostFlairUpdate, onPostUpdate } from "./triggers";
import { handleAccountReviewJob, handleAutoAccountRecoveryJob, handleQueueClassificationChangesJob, handleClassificationReversalsJob, handleCleanupJob, handleConfigWikiChangeJob, handleContinueDataExtract, handleDelayedMessageJob, handleDeleteRecordsForRemovedUsersJob, handleEvaluateKarmaFarmingSubsJob, handleEvaluateUserJob, handleEvaluatorVariableUpdateFromWikiJob, handleFlaggedUserRechecksJob, handleModmailArchiverJob, handleNotifyModTeamOnDemodJob, handlePendingUserReevaluationJob, handleQueueKarmaFarmingSubsJob, handleRapidJob, handleReversePostCreationQueueJob, handleStartDataExtract, handleUptimeMonitor, handlePermissionCheckEnqueueJob, handleDigestSummaryJob, handleClientSubAnnouncementsJob, handleOpenAISummaryGatherJob, handleOpenAIUpdateTokenStatsJob, handleOpenAILookupAndRespondJob, handleObserverSubMinutelyJob, handleMinutelyJob, handleFiveMinutelyJob, handleSixHourlyJob, handleSixHourlyJobPart2, handleAsyncWikiUpdateJob, handleConditionalStatsUpdateJob, handleDefinedHandlesStatsInitializerJob, handleGatherDefinedHandlesStatsJob, handleStoreDefinedHandlesDataJob, handleBuildEvaluatorAccuracyStatisticsJob, handleEvaluatorAccuracyInitializerJob, handleMainStatisticsJob, handleCreateSummariesForPendingUsersJob, handlePendingUserFinderJob, handleUpdateBioStatsJob, handleGenerateBioStatisticsReportJob, handleRedosCheckerJob, handleCheckPermissionQueueItemsJob, handleExternalSubmissionsQueueJob, handleClassificationChangesJob } from "./tasks";
import { handleUpgradeNotifier } from "@fsvreddit/fsv-devvit-web-helpers";
import { handleModQueueRemovalJob } from "./tasks/handleModQueueRemoval";
import { handlePostAndCommentMenu } from "./menus";
import { handleControlSubForm, handleControlSubQuerySubmissionForm, handleQueryForm, handleReportForm, handleShowCurrentEvaluationResultsForm } from "./forms";

const application = new Hono();

// Triggers
application.post("/internal/triggers/on-app-install", onAppInstall);
application.post("/internal/triggers/on-app-upgrade", onAppUpgrade);
application.post("/internal/triggers/on-comment-create", onCommentCreate);
application.post("/internal/triggers/on-comment-update", onCommentUpdate);
application.post("/internal/triggers/on-mod-action", onModAction);
application.post("/internal/triggers/on-modmail", onModMail);
application.post("/internal/triggers/on-post-create", onPostCreate);
application.post("/internal/triggers/on-post-delete", onPostDelete);
application.post("/internal/triggers/on-post-update", onPostUpdate);
application.post("/internal/triggers/on-post-flair-update", onPostFlairUpdate);

// Settings validators
application.post("/internal/validators/select-field-has-option-chosen", handleSelectFieldHasOptionChosen);

// Scheduler jobs
application.post("/internal/tasks/account-review", handleAccountReviewJob);
application.post("/internal/tasks/auto-account-recovery", handleAutoAccountRecoveryJob);
application.post("/internal/tasks/handle-classification-changes", handleClassificationChangesJob);
application.post("/internal/tasks/classification-reversals", handleClassificationReversalsJob);
application.post("/internal/tasks/cleanup-job", handleCleanupJob);
application.post("/internal/tasks/client-sub-announcements", handleClientSubAnnouncementsJob);
application.post("/internal/tasks/handle-config-wiki-change", handleConfigWikiChangeJob);
application.post("/internal/tasks/continue-data-extract", handleContinueDataExtract);
application.post("/internal/tasks/delete-records-for-removed-users", handleDeleteRecordsForRemovedUsersJob);
application.post("/internal/tasks/evaluate-karma-farming-subs", handleEvaluateKarmaFarmingSubsJob);
application.post("/internal/tasks/evaluate-user", handleEvaluateUserJob);
application.post("/internal/tasks/flagged-user-rechecks", handleFlaggedUserRechecksJob);
application.post("/internal/tasks/modmail-archiver", handleModmailArchiverJob);
application.post("/internal/tasks/notify-mod-team-on-demod", handleNotifyModTeamOnDemodJob);
application.post("/internal/tasks/observer-sub-minutely-job", handleObserverSubMinutelyJob);
application.post("/internal/tasks/openai-summary-gather", handleOpenAISummaryGatherJob);
application.post("/internal/tasks/openai-summary-lookup", handleOpenAILookupAndRespondJob);
application.post("/internal/tasks/openai-update-token-stats-message", handleOpenAIUpdateTokenStatsJob);
application.post("/internal/tasks/pending-user-reevaluation", handlePendingUserReevaluationJob);
application.post("/internal/tasks/permission-check-enqueue", handlePermissionCheckEnqueueJob);
application.post("/internal/tasks/post-creation-queue-reversals", handleReversePostCreationQueueJob);
application.post("/internal/tasks/queue-karma-farming-subs", handleQueueKarmaFarmingSubsJob);
application.post("/internal/tasks/queue-reclassification-changes", handleQueueClassificationChangesJob);
application.post("/internal/tasks/notify-mod-team-on-demod", handleNotifyModTeamOnDemodJob);
application.post("/internal/tasks/process-delayed-messages", handleDelayedMessageJob);
application.post("/internal/tasks/rapid-job", handleRapidJob);
application.post("/internal/tasks/remove-users-from-modqueue-after-ban", handleModQueueRemovalJob);
application.post("/internal/tasks/send-daily-digest", handleDigestSummaryJob);
application.post("/internal/tasks/start-data-extract", handleStartDataExtract);
application.post("/internal/tasks/update-evaluator-variables", handleEvaluatorVariableUpdateFromWikiJob);
application.post("/internal/tasks/upgrade-notifier", handleUpgradeNotifier);
application.post("/internal/tasks/uptime-monitor", handleUptimeMonitor);
application.post("/internal/tasks/perform-minutely-jobs", handleMinutelyJob);
application.post("/internal/tasks/perform-5-minutely-jobs", handleFiveMinutelyJob);
application.post("/internal/tasks/perform-6-hourly-jobs", handleSixHourlyJob);
application.post("/internal/tasks/perform-6-hourly-jobs-part2", handleSixHourlyJobPart2);
application.post("/internal/tasks/async-wiki-update", handleAsyncWikiUpdateJob);
application.post("/internal/tasks/conditional-stats-update", handleConditionalStatsUpdateJob);
application.post("/internal/tasks/defined-handles-statistics-initialiser", handleDefinedHandlesStatsInitializerJob);
application.post("/internal/tasks/defined-handles-statistics", handleGatherDefinedHandlesStatsJob);
application.post("/internal/tasks/defined-handles-post-store", handleStoreDefinedHandlesDataJob);
application.post("/internal/tasks/evaluator-accuracy-statistics-initialiser", handleEvaluatorAccuracyInitializerJob);
application.post("/internal/tasks/evaluator-accuracy-statistics", handleBuildEvaluatorAccuracyStatisticsJob);
application.post("/internal/tasks/main-statistics-update", handleMainStatisticsJob);
application.post("/internal/tasks/create-summaries-for-pending-users", handleCreateSummariesForPendingUsersJob);
application.post("/internal/tasks/pending-user-finder", handlePendingUserFinderJob);
application.post("/internal/tasks/bio-stats-update", handleUpdateBioStatsJob);
application.post("/internal/tasks/bio-stats-generate-report", handleGenerateBioStatisticsReportJob);
application.post("/internal/tasks/evaluator-redos-checker", handleRedosCheckerJob);
application.post("/internal/tasks/check-permission-queue-items", handleCheckPermissionQueueItemsJob);
application.post("/internal/tasks/external-submissions-queue", handleExternalSubmissionsQueueJob);

// Menus
application.post("/internal/menu/report-user", handlePostAndCommentMenu);

// Form handlers
application.post("/internal/forms/client-sub-report-user", handleReportForm);
application.post("/internal/forms/client-sub-query-user", handleQueryForm);
application.post("/internal/forms/control-sub-form", handleControlSubForm);
application.post("/internal/forms/control-sub-query-submission-form", handleControlSubQuerySubmissionForm);
application.post("/internal/forms/show-current-evaluation-form", handleShowCurrentEvaluationResultsForm);

const server = createServer(getRequestListener(application.fetch));
server.on("error", (err) => {
    console.error(`server error; ${err.stack}`);
});

const port = getServerPort();
server.listen(port);
