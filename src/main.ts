import { Devvit, FormField } from "@devvit/public-api";
import { handleControlSubSubmission } from "./handleControlSubSubmission.js";
import { updateLocalStoreFromWiki, updateWikiPage, updateStatisticsPages } from "./dataStore.js";
import { ADHOC_CLEANUP_JOB, CLEANUP_JOB, CONTROL_SUBREDDIT, EVALUATE_KARMA_FARMING_SUBS, EVALUATE_USER, EXTERNAL_SUBMISSION_JOB, HANDLE_CLASSIFICATION_CHANGES_JOB, SEND_DAILY_DIGEST, UPDATE_DATASTORE_FROM_WIKI, UPDATE_EVALUATOR_VARIABLES, UPDATE_STATISTICS_PAGE, UPDATE_WIKI_PAGE_JOB, UPGRADE_NOTIFIER_JOB } from "./constants.js";
import { handleInstallOrUpgrade } from "./installActions.js";
import { handleControlSubFlairUpdate } from "./handleControlSubFlairUpdate.js";
import { appSettings } from "./settings.js";
import { cleanupDeletedAccounts } from "./cleanup.js";
import { handleModAction } from "./handleModAction.js";
import { handleModmail } from "./modmail/modmail.js";
import { handleControlSubAccountEvaluation } from "./handleControlSubAccountEvaluation.js";
import { handleReportUser, reportFormHandler } from "./handleReportUser.js";
import { processExternalSubmissions } from "./externalSubmissions.js";
import { handleClientCommentCreate, handleClientPostCreate } from "./handleClientPostOrComment.js";
import { handleClientSubCommentDelete, handleClientSubPostDelete } from "./handleClientSubContentDelete.js";
import { handleClassificationChanges } from "./handleClientSubredditWikiUpdate.js";
import { handleControlSubPostDelete } from "./handleControlSubPostDelete.js";
import { updateEvaluatorVariablesFromWikiHandler } from "./userEvaluation/evaluatorVariables.js";
import { evaluateKarmaFarmingSubs } from "./karmaFarmingSubsCheck.js";
import { handleControlSubForm } from "./handleControlSubMenu.js";
import { checkForUpdates } from "./upgradeNotifier.js";
import { sendDailyDigest } from "./modmail/dailyDigest.js";

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
            label: "Show the above text publicly on the post on r/BotBouncer",
            defaultValue: true,
            name: "publicContext",
        },
    ],
}, reportFormHandler);

export const controlSubForm = Devvit.createForm(data => ({ title: data.title as string, description: data.description as string, fields: data.fields as FormField[] }), handleControlSubForm);

Devvit.addSchedulerJob({
    name: UPDATE_WIKI_PAGE_JOB,
    onRun: updateWikiPage,
});

Devvit.addSchedulerJob({
    name: UPDATE_DATASTORE_FROM_WIKI,
    onRun: updateLocalStoreFromWiki,
});

Devvit.addSchedulerJob({
    name: HANDLE_CLASSIFICATION_CHANGES_JOB,
    onRun: handleClassificationChanges,
});

Devvit.addSchedulerJob({
    name: EVALUATE_USER,
    onRun: handleControlSubAccountEvaluation,
});

Devvit.addSchedulerJob({
    name: CLEANUP_JOB,
    onRun: cleanupDeletedAccounts,
});

Devvit.addSchedulerJob({
    name: ADHOC_CLEANUP_JOB,
    onRun: cleanupDeletedAccounts,
});

Devvit.addSchedulerJob({
    name: EXTERNAL_SUBMISSION_JOB,
    onRun: processExternalSubmissions,
});

Devvit.addSchedulerJob({
    name: UPDATE_STATISTICS_PAGE,
    onRun: updateStatisticsPages,
});

Devvit.addSchedulerJob({
    name: UPDATE_EVALUATOR_VARIABLES,
    onRun: updateEvaluatorVariablesFromWikiHandler,
});

Devvit.addSchedulerJob({
    name: EVALUATE_KARMA_FARMING_SUBS,
    onRun: evaluateKarmaFarmingSubs,
});

Devvit.addSchedulerJob({
    name: UPGRADE_NOTIFIER_JOB,
    onRun: checkForUpdates,
});

Devvit.addSchedulerJob({
    name: SEND_DAILY_DIGEST,
    onRun: sendDailyDigest,
});

Devvit.configure({
    redditAPI: true,
    redis: true,
});

export default Devvit;
