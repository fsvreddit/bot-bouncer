import { Devvit } from "@devvit/public-api";
import { handleControlSubSubmission } from "./handleControlSubSubmission.js";
import { updateLocalStoreFromWiki, updateWikiPage, writeAggregateToWikiPage } from "./dataStore.js";
import { ADHOC_CLEANUP_JOB, CLEANUP_JOB, CONTROL_SUBREDDIT, EVALUATE_USER, EXTERNAL_SUBMISSION_JOB, HANDLE_CLASSIFICATION_CHANGES_JOB, UPDATE_DATASTORE_FROM_WIKI, UPDATE_EVALUATOR_VARIABLES, UPDATE_STATISTICS_PAGE, UPDATE_WIKI_PAGE_JOB } from "./constants.js";
import { handleInstallOrUpgrade } from "./installActions.js";
import { handleControlSubFlairUpdate } from "./handleControlSubFlairUpdate.js";
import { appSettings } from "./settings.js";
import { cleanupDeletedAccounts } from "./cleanup.js";
import { handleModAction } from "./handleModAction.js";
import { handleModmail } from "./modmail.js";
import { handleControlSubAccountEvaluation } from "./handleControlSubAccountEvaluation.js";
import { handleReportUser, reportFormHandler } from "./handleReportUser.js";
import { processExternalSubmissions } from "./externalSubmissions.js";
import { handleClientCommentCreate, handleClientPostCreate } from "./handleClientPostOrComment.js";
import { handleClientSubCommentDelete, handleClientSubPostDelete } from "./handleClientSubContentDelete.js";
import { handleClassificationChanges } from "./handleClientSubredditWikiUpdate.js";
import { createUserSummaryJobHandler } from "./UserSummary/userSummary.js";
import { handleControlSubPostDelete } from "./handleControlSubPostDelete.js";
import { updateEvaluatorVariablesFromWikiHandler } from "./userEvaluation/evaluatorVariables.js";

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
            label: "Please provide more information that might help us understand why this is a bot",
            helpText: "Optional. This is in case it is not obvious that this is a LLM bot.",
            lineHeight: 4,
            name: "reportContext",
        },
    ],
}, reportFormHandler);

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
    onRun: writeAggregateToWikiPage,
});

Devvit.addSchedulerJob({
    name: UPDATE_EVALUATOR_VARIABLES,
    onRun: updateEvaluatorVariablesFromWikiHandler,
});

Devvit.configure({
    redditAPI: true,
    redis: true,
});

export default Devvit;
