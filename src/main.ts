import { Devvit } from "@devvit/public-api";
import { handleBackroomSubmission } from "./handleBackroomSubmission.js";
import { handleUnbans, updateLocalStoreFromWiki, updateWikiPage } from "./dataStore.js";
import { ADHOC_CLEANUP_JOB, CLEANUP_JOB, HANDLE_UNBANS_JOB, PROCESS_PENDING_QUEUE, UPDATE_DATASTORE_FROM_WIKI, UPDATE_WIKI_PAGE_JOB } from "./constants.js";
import { handleInstallOrUpgrade } from "./installActions.js";
import { handleBackroomFlairUpdate } from "./handleBackroomFlairUpdate.js";
import { appSettings } from "./settings.js";
import { cleanupDeletedAccounts } from "./cleanup.js";
import { handleModAction } from "./handleModAction.js";
import { processPendingQueue } from "./pendingQueue.js";

Devvit.addSettings(appSettings);

Devvit.addTrigger({
    event: "PostCreate",
    onEvent: handleBackroomSubmission,
});

Devvit.addTrigger({
    event: "PostFlairUpdate",
    onEvent: handleBackroomFlairUpdate,
});

Devvit.addTrigger({
    events: ["AppInstall", "AppUpgrade"],
    onEvent: handleInstallOrUpgrade,
});

Devvit.addTrigger({
    event: "ModAction",
    onEvent: handleModAction,
});

Devvit.addSchedulerJob({
    name: UPDATE_WIKI_PAGE_JOB,
    onRun: updateWikiPage,
});

Devvit.addSchedulerJob({
    name: UPDATE_DATASTORE_FROM_WIKI,
    onRun: updateLocalStoreFromWiki,
});

Devvit.addSchedulerJob({
    name: HANDLE_UNBANS_JOB,
    onRun: handleUnbans,
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
    name: PROCESS_PENDING_QUEUE,
    onRun: processPendingQueue,
});

Devvit.configure({
    redditAPI: true,
    redis: true,
});

export default Devvit;
