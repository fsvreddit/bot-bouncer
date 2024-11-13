# NicolaBot

A moderation bot for /r/unitedkingdom (initially, at least). Provides "quick actions" for common tasks, both via !commands and via menu actions.

## Standard mod commands

Most commands need to be the first part of the comment and will not run if the command is later in the message body. Where exceptions exist, they will be noted.

###!announce

Use this command anywhere in the post's replies. Creates a sticky comment on the post, useful for providing extra context, reminding users to stick to the rules, and so on.

> !announce You would create a sticky comment like this.

> And yes, multi-line comments are supported.

###!reply

Use this command in a reply to another comment. Creates a distinguished comment in reply to the comment you are replying to. Useful if you want to reply to a user without revealing your username.

> !reply Please don't insult other users. Address the points made, not the person.

###!highlight

Use this command anywhere in the post's replies. Creates a sticky comment on the post with a link to the comment you replied to, drawing attention to it. Useful if a commenter has provided valuable extra context, fact checking, or similar.

> !highlight

Might result in

> **Note**:

> We would like to highlight [this comment](https://www.reddit.com/r/fsvsandbox/comments/16015ce/royal_mail_celebrates_paddington_bears_65th/jys873q/), given by /u/fsv

###!edit

Use this command in reply to a comment made by the app account. Edits the comment you reply to with the new text

> !edit I wanted to say something different

###!pow

A quick ban command. Usage:

> !pow [duration] [reason]

Examples:

Ban a user for 7 days with the reason "Personal attack".

> !pow 7 Personal attack

Ban a user indefinitely for racism:

> !pow Racism

You can omit either the duration or the reason, so "!pow 15" would ban for 15 days with no reason given, and "!pow" on its own would ban indefinitely with no reason given.

## Configurable mod commands

A set of extra moderation commands is configured in a JSON object in the app configuration.

Example command JSON:

    [
        {
            "shortCommand": "nice",
            "friendlyName": "Be Nice/Civil/Don't Judge",
            "nukeComments": true,
            "commentReply": "Your post/comment has been removed for breaking **Rule 1 - Be Nice, Civil Discourse, Don't Judge**\n\nYou must read the [rules](https://www.reddit.com/r/ukpersonalfinance/about/rules/) to continue to post to our subreddit.",
            "banLength": 7,
            "banMessage": "Uncivil language or judgemental content",
            "userNote": "Uncivil or judgemental comment"
        },
    ]

This comment might be invoked by the command !nice, or via a menu action. 

The available attributes for the commands are:

* shortCommand: string, mandatory. The short name of the command to run. A value of "vio" would mean your command is !vio.
* shortCommandSynonyms: array of string, optional. Alternate short names you want to give to the same command.
* friendlyName: string, mandatory. The name to display in the form that shows when you use the menu on New Reddit or mobile.
* nukeComments: boolean, optional. If set to true, the comment and all descendants (other than distinguished comments by mods) will be removed.
* commentReply: string, optional. If set, the bot will reply with this text.
* banLength: number, optional. If set, the bot will ban for this many days.
* banMessage: string, optional. If set, the bot will use this message when banning a user.
* userNote: string, optional. If set, the bot will leave a Toolbox usernote with this text.

Configurable commands can be used in two ways. 

You can use these commands via replies, just like the standard commands. The "shortCommand" or a "shortCommandSynonym" must be the first part of the comment, after a !.

On New Reddit and official Reddit mobile apps, you can use the menu item "Mod Command". This will show a list of all configurable commands that exist.

## Modnote Notifier

You can configure the app to alert when a subreddit user accrues more than a configured number of usernotes via app commands, with a limit on how often a notification is sent.

The message is sent inside modmail to the moderator who added the most recent usernote.

## Single focus account checker

Creates a report on posts if a large proportion (configurable) of a user's posts come from the same domain. Used to weed out spammers. 

## Mod activity report

Gives a clear view of moderation activity and mods' activity across Reddit as a whole. Useful for identifying if a mod is extremely inactive

## Rate Limiter

Allows thresholds to be configured through JSON to remove posts if too many are made in too short a timeframe.

## Duplicate handling

### Automatic

When a new post is made, the bot checks the last 100 posts made in the subreddit and attempts to find duplicate articles. This is done in two different ways:

* URL matching - if the URLs are the same (after domain substitution, and removing any extraneous data like query strings and anchors), they are treated as an exact match.
* Title similarity

Titles are compared using a function similar to Python's Sequence Matcher ratio() function, giving a value.

If the URLs are the same, or the titles similar enough (the threshold is configurable), the post is removed and a list of potential duplicate candidates is left in reply. As long as the post wasn't removed by Reddit's spam filters or Automoderator, the user is invited to self-approve the post by using a !notdupe command.

It is recommended that you set a higher threshold for autoremoving a post than the threshold for proposing alternatives. Values of 80 (for autoremoval) and 60 (for suggestions) work well.

### Manual

#### Bot commands

The !dupe command allows a moderator to mark one post as a duplicate of another.

!dupe on its own will run the same process as the automatic duplicate handling. This is not recommended. Instead, you can use !dupe with a particular post's permalink or post ID e.g.

> !dupe https://www.reddit.com/r/fsvsandbox/comments/16015ce/royal_mail_celebrates_paddington_bears_65th/

> !dupe https://redd.it/16015ce

> !dupe 16015ce

If a !dupe command is issued with a parameter, the bot will still suggest matches like the automatic method, but the mod suggestion will be the top item and be clearly marked as such.

#### Menu commands

If a moderator uses the "Mark as Duplicate" menu function, a list of potential matches will be shown (using the same matching algorithm as before). Choose one of those items and the post will be marked as a duplicate as if they had used !dupe.

#### Flair

A moderator can change a post flair to a Reddit permalink (e.g. a Reddit short link like https://redd.it/169ny5w), and the post will be treated as if a !dupe command had been used. Duplicate removal flair formats also include full permalinks, and the post ID in isolation.

#### User reports

A user can report a post as a duplicate using a free text report that starts "dup" and contains a Reddit URL (short or full) other than a sharelink.

The bot will remove the post and offer the user the chance to !notdupe the post unless the URLs are the same.

## Flair removals

This is especially useful for subreddits that use the Mod Toolbox extension and have removal reasons configured.

To set this up, add a post flair for each of the Toolbox removal reasons that you want to remove using flairs. The flairs must have a CSS class of "removed".

The flair text does not have to exactly match the Toolbox removal reason name, but there must be a "removal code" in common. This bot uses regexes with a single capturing group for both the flair and the removal reason.

For example, you might have set up flairs and removal reasons identically, with names like "s2 - No editorialised titles | 0xA3". In this case, the 0xA3 is the "code". You would create a regex that would capture that text alone from the flair, e.g. `(0x..)$`.

Alternatively, you might have friendly removal reason names with rule numbers e.g. "Rule 1: Be nice", and flairs like "!1 be nice". In this case you might have different regexes, like a removal reason regex of `^Rule (\d+)` and a flair regex of `^!(\d+)`. As long as the output from the capturing groups on both sides match, the rule will be chosen.

When removing content, the Toolbox configuration for headers, footers, locking posts, etc. is respected, and all placeholders (e.g. {kind}) are populated.

### Special case: Flair removal with duplicate detection

You can configure a removal code in the app's settings to trigger duplicate detection. If you remove a post with a flair/removal reason that uses that code, a list of suggested duplicates will be added after the removal reason and before the footer.

## Alternate Source suggestions

When a post is removed as a duplicate via the menu command or the !dupe command, the URL for the post will be added as a suggestion on the post it's been reported as a duplicate of.

If a post was detected automatically as a duplicate, or reported as a duplicate by a user, the original post's author may use the command !alt to add the suggestion.

There is a website whitelist in effect to reduce abuse.

## Nuke enforcer

/r/unitedkingdom has a policy of nuking comment trees when removing comments.

This function ensures that this is done by detecting comment removals by human moderators or AEO, and will nuke the rest of the tree automatically after a short delay.
