import { SettingsFormField } from "@devvit/public-api";
import { CONTROL_SUBREDDIT } from "./constants.js";

export const CONFIGURATION_DEFAULTS = {
    banMessage: `Bots and bot-like accounts are not welcome on /r/{subreddit}.

[I am a bot, and this action was performed automatically](/r/${CONTROL_SUBREDDIT}/wiki/index).
If you wish to appeal the classification of the /u/{account} account, please
[message /r/${CONTROL_SUBREDDIT}](https://www.reddit.com/message/compose?to=/r/${CONTROL_SUBREDDIT}&subject=Ban%20dispute%20for%20/u/{account}%20on%20/r/{subreddit})
rather than replying to this message.`,

    banNote: "Banned by /u/{me} at {date}",

    noteClient: `/u/{account} is [listed on /r/${CONTROL_SUBREDDIT}]({link}).

If this account is claiming to be human and isn't an obvious novelty account,
we recommend asking the account owner to [message /r/${CONTROL_SUBREDDIT}](https://www.reddit.com/message/compose?to=/r/${CONTROL_SUBREDDIT}&subject=Ban%20dispute%20for%20/u/{account}%20on%20/r/{subreddit}).

If this account is a bot that you wish to allow, remember to [whitelist](/r/${CONTROL_SUBREDDIT}/wiki/index) it before you unban it.`,

    appealMessage: `Your classification appeal has been received and will be reviewed by a
moderator. If accepted, the result of your appeal will apply to any subreddit using /r/${CONTROL_SUBREDDIT}.
*This is an automated message.*`,
};

export enum AppSetting {
    BanMessage = "banMessage",
    ModmailNote = "clientModmailNote",
    RemoveRecentContent = "removeRecentContent",
}

export const appSettings: SettingsFormField[] = [
    {
        type: "paragraph",
        name: AppSetting.BanMessage,
        label: "Ban message to use when banning user",
        helpText: "Supports placeholders {account}, {subreddit}",
        defaultValue: CONFIGURATION_DEFAULTS.banMessage,
    },
    {
        type: "string",
        name: AppSetting.ModmailNote,
        label: "Template for private moderator note that will be added if banned users write in",
        helpText: `Supports placeholders {account}, {subreddit} and {link} (which links to the submission on /r/${CONTROL_SUBREDDIT}`,
        defaultValue: CONFIGURATION_DEFAULTS.noteClient,
    },
    {
        type: "boolean",
        name: AppSetting.RemoveRecentContent,
        label: "Remove recent content from newly classified users on your subreddit even if they don't post again",
        defaultValue: true,
    },
];
