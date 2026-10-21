import { CONTROL_SUBREDDIT } from "./constants";

export const CONFIGURATION_DEFAULTS = {
    banMessage: `Bots and bot-like accounts are not welcome on /r/{subreddit}.

[I am a bot, and this action was performed automatically](/r/${CONTROL_SUBREDDIT}/wiki/index).
**If you wish to appeal the classification of the /u/{account} account, please
[message /r/${CONTROL_SUBREDDIT}](https://www.reddit.com/message/compose?to=/r/${CONTROL_SUBREDDIT}&subject=Ban%20dispute%20for%20/u/{account}%20on%20/r/{subreddit}&message=bot%20classification%20appeal)
rather than replying to this message.**`,

    banNote: "Banned by /u/{me} at {date}",

    noteClient: `/u/{account} is [listed on /r/${CONTROL_SUBREDDIT}]({link}).

If this account is claiming to be human and isn't an obvious novelty account,
we recommend asking the account owner to [message /r/${CONTROL_SUBREDDIT}](https://www.reddit.com/message/compose?to=/r/${CONTROL_SUBREDDIT}&subject=Ban%20dispute%20for%20/u/{account}%20on%20/r/{subreddit}&message=bot%20classification%20appeal).

If this account is a bot that you wish to allow, remember to [allowlist](/r/${CONTROL_SUBREDDIT}/wiki/index) it before you unban it.`,

    appealShadowbannedMessage: `Your classification appeal has been received. Unfortunately, it is not possible to review your request at this time because you have been shadowbanned by Reddit Admin, which prevents us from reviewing your account contents.

You may appeal your shadowban by contacting the Reddit Admins [here](https://reddit.com/appeal). If you are able to get your shadowban lifted, please contact us again and we will be happy to review your classification status.

*This is an automated message.*`,

    recentAppealMade: `We have already received an appeal from you. There is no need to appeal for every subreddit that Bot Bouncer has banned you from.

Your initial appeal will be reviewed shortly by a moderator. If accepted, the result of your appeal will apply to any subreddit using /r/${CONTROL_SUBREDDIT}.

*This is an automated message.*`,

    appRemovedMessage: `Hi,

{modName} has removed Bot Bouncer from r/{subredditName}. As a result, Bot Bouncer will no longer be able to perform moderation tasks or provide its services on this subreddit.

As Bot Bouncer is a developer platform app, it needs to be removed properly from the list of installed apps, which you can find [here](https://developers.reddit.com/r/{subredditName}/apps).

If you did not mean to remove Bot Bouncer, you must first uninstall it from the link above, and then you can re-add it from the app listing [here](https://developers.reddit.com/apps/bot-bouncer). Please don't invite this user account to the mod list manually - it won't be able to accept the invite.

If you are removing Bot Bouncer because of concerns about how it works, we would love to hear from you. Please modmail r/BotBouncer with any feedback you may have.`,
};

export enum AppSetting {
    Action = "action",
    LockContentWhenRemoving = "lockContentWhenRemoving",
    RemoveFromModqueueWhenBanning = "removeFromModqueueWhenBanning",
    RemoveReportedContentOnReport = "removeReportedContentOnReport",
    BanMessage = "banMessage",
    AutoWhitelist = "autoWhitelist",
    ExemptApprovedUsers = "exemptApprovedUsers",
    AddModNoteOnClassificationChange = "addModNoteOnClassificationChange",
    ModmailNote = "clientModmailNote",
    AddModmailIfNotBannedYet = "addModmailIfNotBannedYet",
    Digest = "dailyDigest",
    DigestNewMessageEachDay = "dailyDigestNewMessageEachDay",
    DigestFrequency = "dailyDigestFrequency",
    DigestAsModNotification = "dailyDigestAsModNotification",
    DigestIncludeReported = "dailyDigestIncludeReported",
    DigestIncludeBanned = "dailyDigestIncludeBanned",
    DigestIncludeUnbanned = "dailyDigestIncludeUnbanned",
    UpgradeNotifier = "upgradeNotifier",

    // App-scoped secrets
    OpenAIKey = "openAIKey",
    OpenAIEvaluationKey = "openAIEvaluationKey",
    OpenAIAdminKey = "openAIAdminKey",
    OpenAIProjectId = "openAIProjectId",
    DisableClientChecks = "disableClientChecks",
}

export enum ActionType {
    Ban = "ban",
    Filter = "filter",
    Report = "report",
}

export enum DigestFrequency {
    Daily = "daily",
    Weekly = "weekly",
}
