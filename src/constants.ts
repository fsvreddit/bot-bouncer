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
}

/**
 * Job names
 */
export const UPDATE_WIKI_PAGE_JOB = "updateWikiPage";
export const UPDATE_DATASTORE_FROM_WIKI = "updateDatastoreFromWiki";
export const HANDLE_UNBANS_JOB = "handleUnbansJob";
export const CLEANUP_JOB = "cleanupJob";
export const ADHOC_CLEANUP_JOB = "adhocCleanup";
export const CLEANUP_JOB_CRON = "0 6 * * *";
