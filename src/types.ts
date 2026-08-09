export enum WikiPagePermissionLevel {
    /** Use subreddit wiki permissions */
    SUBREDDIT_PERMISSIONS = 0,
    /** Only approved wiki contributors for this page may edit */
    APPROVED_CONTRIBUTORS_ONLY = 1,
    /** Only mods may edit and view */
    MODS_ONLY = 2,
}
