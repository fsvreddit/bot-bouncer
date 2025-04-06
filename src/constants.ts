/**
 * The subreddit that is used for user submissions
 */
export const CONTROL_SUBREDDIT = "BotBouncer";

export enum PostFlairTemplate {
    Pending = "fb53b906-a19f-11ef-bc80-ca18933c38fe",
    Banned = "0ab378aa-a1a0-11ef-bd1f-fe6cc3602208",
    Service = "1dbb83ac-a1a0-11ef-b683-7ef1bd574708",
    Organic = "301b4a0a-a1a0-11ef-9bc1-c67e6d699878",
    Purged = "46c7d570-a1a0-11ef-a875-ca4499635235",
    Retired = "5dc983ae-a1a0-11ef-8101-ca18933c38fe",
    Declined = "66cbc876-bede-11ef-92ec-ea42900b9dcb",
    Inactive = "82f4d952-bede-11ef-9dec-4a43f41509f3",
}

/**
 * Job names: All Subreddits
 */
export enum UniversalJob {
    Cleanup = "cleanupJob",
    AdhocCleanup = "adhocCleanup",
    UpdateEvaluatorVariables = "updateEvaluatorVariables",
}

/**
 * Job names: Control Subreddit
 */

export enum ControlSubredditJob {
    UpdateWikiPage = "updateWikiPage",
    EvaluateUser = "evaluateUser",
    ExternalSubmission = "externalSubmission",
    UpdateStatisticsPage = "updateStatisticsPage",
    EvaluateKarmaFarmingSubs = "evaluateKarmaFarmingSubs",
    CopyControlSubSettings = "copyControlSubSettings",
    UptimeAndMessageCheck = "uptimeAndMessageCheck",
}

/**
 * Job names: Client Subreddit
 */

export enum ClientSubredditJob {
    UpdateDatastoreFromWiki = "updateDatastoreFromWiki",
    HandleClassificationChanges = "handleClassificationChanges",
    UpgradeNotifier = "upgradeNotifier",
    SendDailyDigest = "sendDailyDigest",
}

/**
 * Job crons
 */
export const CLEANUP_JOB_CRON = "0 6 * * *";
export const EXTERNAL_SUBMISSION_JOB_CRON = "17 * * * *";
