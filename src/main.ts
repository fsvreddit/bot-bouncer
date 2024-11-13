import { Devvit } from "@devvit/public-api";
import { handleBackroomSubmission } from "./handleBackroomSubmission.js";
import { updateLocalStoreFromWiki, updateWikiPage } from "./dataStore.js";
import { UPDATE_DATASTORE_FROM_WIKI, UPDATE_WIKI_PAGE_JOB } from "./constants.js";
import { handleInstallOrUpgrade } from "./installActions.js";
import { handleBackroomFlairUpdate } from "./handleBackroomFlairUpdate.js";

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

Devvit.addSchedulerJob({
    name: UPDATE_WIKI_PAGE_JOB,
    onRun: updateWikiPage,
});

Devvit.addSchedulerJob({
    name: UPDATE_DATASTORE_FROM_WIKI,
    onRun: updateLocalStoreFromWiki,
});

Devvit.configure({
    redditAPI: true,
    redis: true,
});

export default Devvit;
