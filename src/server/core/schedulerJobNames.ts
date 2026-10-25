/**
 * Job names: All Subreddits
 */
export enum UniversalJob {
    Cleanup = "cleanupJob",
}

/**
 * Job names: Control Subreddit
 */
export enum ControlSubredditJob {
    EvaluateUser = "evaluateUser",
    Perform6HourlyJobs = "perform6HourlyJobs",
    Perform6HourlyJobsPart2 = "perform6HourlyJobsPart2",
    Perform5MinutelyJobs = "perform5MinutelyJobs",
    PerformMinutelyJobs = "performMinutelyJobs",
    EvaluateKarmaFarmingSubs = "evaluateKarmaFarmingSubs",
    QueueKarmaFarmingSubs = "queueKarmaFarmingSubs",
    UptimeAndMessageCheck = "uptimeAndMessageCheck",
    RapidJob = "rapidJob",
    EvaluatorAccuracyStatisticsInitialiser = "evaluatorAccuracyStatisticsInitialiser",
    EvaluatorAccuracyStatistics = "evaluatorAccuracyStatistics",
    DefinedHandlesStatisticsInitialiser = "definedHandlesStatisticsInitialiser",
    DefinedHandlesStatistics = "definedHandlesStatistics",
    DefinedHandlesPostStore = "definedHandlesPostStore",
    ClassificationReversals = "classificationReversals",
    PostCreationQueueReversals = "postCreationQueueReversals",
    DeleteRecordsForRemovedUsers = "deleteRecordsForRemovedUsers",
    HandleConfigWikiChange = "handleConfigWikiChange",
    ConditionalStatsUpdate = "conditionalStatsUpdate",
    AsyncWikiUpdate = "asyncWikiUpdate",
    BioStatsUpdate = "bioStatsUpdate",
    BioStatsGenerateReport = "bioStatsGenerateReport",
    MainStatisticsUpdate = "mainStatisticsUpdate",
    StartDataExtract = "startDataExtract",
    ContinueDataExtract = "continueDataExtract",
    UpdateEvaluatorVariables = "updateEvaluatorVariables",
    EvaluatorReDoSChecker = "evaluatorReDoSChecker",
    CheckPermissionQueueItems = "checkPermissionQueueItems",
    AccountReview = "accountReview",
    PendingUserFinder = "pendingUserFinder",
    CreateSummaries = "createSummaries",
    OpenAISummaryGather = "openAISummary",
    OpenAISummaryLookup = "openAISummaryLookup",
    OpenAIUpdateTokenStatsMessage = "openAIUpdateTokenStatsMessage",
    FlaggedUsersRechecks = "flaggedUsersRechecks",
    ProcessDelayedMessages = "processDelayedMessages",
    AutoAccountRecovery = "autoAccountRecovery",
    ModmailArchiver = "modmailArchiver",
    ExternalSubmissionsQueue = "externalSubmissionsQueue",
    PendingUserReevaluation = "pendingUserReevaluation",
    UnprocessedSubmissionsHandler = "unprocessedSubmissionsHandler",
}

/**
 * Job names: Client Subreddit
 */
export enum ClientSubredditJob {
    QueueReclassificationChanges = "queueReclassificationChanges",
    HandleClassificationChanges = "handleClassificationChanges",
    RemoveUsersFromModqueueAfterBan = "removeUsersFromModqueueAfterBan",
    UpgradeNotifier = "upgradeNotifier",
    SendDailyDigest = "sendDailyDigest",
    NotifyModTeamOnDemod = "notifyModTeamOnDemod",
    PermissionCheckEnqueue = "permissionCheckEnqueue",
    ClientSubAnnouncements = "clientSubAnnouncements",
}

/**
 * Job names: Observer Subreddit
 */
export enum ObserverSubredditJob {
    HandleObserverSubMinutelyJob = "observerSubMinutelyJob",
}
