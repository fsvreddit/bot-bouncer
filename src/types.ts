export enum WikiPagePermissionLevel {
    /** Use subreddit wiki permissions */
    SUBREDDIT_PERMISSIONS = 0,
    /** Only approved wiki contributors for this page may edit */
    APPROVED_CONTRIBUTORS_ONLY = 1,
    /** Only mods may edit and view */
    MODS_ONLY = 2,
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type RecoveredAccountsData = {
    firstRun: boolean;
    jobGuid: string;
};

export enum UserStatus {
    Pending = "pending",
    Banned = "banned",
    Service = "service",
    Organic = "organic",
    Purged = "purged",
    Retired = "retired",
    Inactive = "inactive",
}

export enum UserFlag {
    HackedAndRecovered = "recovered",
    Scammed = "scammed",
    Locked = "locked",
    FutureNSFW = "futurensfw",
}
