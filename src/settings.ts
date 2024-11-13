import { SettingsFormField } from "@devvit/public-api";

const CONFIGURATION_DEFAULTS = {
    banMessage: `Bots and bot-like accounts are not welcome on /r/{subreddit}.

[I am a bot, and this action was performed automatically](/r/{home}/wiki/index).
If you wish to appeal the classification of the /u/{account} account, please
[message /r/{home}](https://www.reddit.com/message/compose?to=/r/{home}&subject=Ban%20dispute%20for%20/u/{account}%20on%20/r/{subreddit})
rather than replying to this message.`,

    banNote: "/u/{account} banned by /u/{me} at {date} for {reason}",

    noteHome: "/u/{account} is [currently classified as **{classification}**]({link}).",

    noteClient: `/u/{account} is [listed on /r/{home}]({link}).

If this account is claiming to be human and isn't an obvious novelty account,
we recommend asking the account owner to [message /r/{home}](https://www.reddit.com/message/compose?to=/r/{home}&subject=Ban%20dispute%20for%20/u/{account}%20on%20/r/{subreddit}).

If this account is a bot that you wish to allow, remember to [whitelist](/r/{home}/wiki/index) it before you unban it.`,

    appealMessage: `Your classification appeal has been received and will be reviewed by a
moderator. If accepted, the result of your appeal will apply to any subreddit using /r/{home}.
*This is an automated message.*`,
};

export enum AppSetting {
    BanMessage = "banMessage",
    BanNote = "banNote",
    ModmailNote = "clientModmailNote",
}

export const appSettings: SettingsFormField[] = [
    {
        type: "paragraph",
        name: AppSetting.BanMessage,
        label: "Ban message to use when banning user",
        defaultValue: CONFIGURATION_DEFAULTS.banMessage,
    },
    {
        type: "string",
        name: AppSetting.BanNote,
        label: "Note to add in banned users list",
        defaultValue: CONFIGURATION_DEFAULTS.banNote,
    },
    {
        type: "string",
        name: AppSetting.ModmailNote,
        label: "Template for private moderator note that will be added if banned users write in",
        defaultValue: CONFIGURATION_DEFAULTS.noteClient,
    },
];
