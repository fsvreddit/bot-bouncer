Bot Bouncer is a Dev Platform app that bans bots and other harmful accounts from subreddits that use it. It is heavily inspired by BotDefense, which wrapped up operations in 2023.

Bots are classified via submissions on [/r/BotBouncer](https://www.reddit.com/r/BotBouncer/), via a mix of automated and human classification.

If you add Bot Bouncer to your sub via the Dev Platform app directory, it will watch for all new submissions and comments from users, and if the account is classified as a bot by the app, it will be banned.

Bot Bouncer is open source. [You can find the source code on GitHub here](https://github.com/fsvreddit/bot-bouncer). Bot Bouncer has a [wiki] that describes in more detail how the app operates.

## The ban process

If a user creates a post or comment on your subreddit and the user is classified as a bot already, the post or comment will be removed immediately and the user banned. Newly classified bots will also be banned if they have posted or commented on your subreddit within the past week shortly after being classified.

Mods can choose to configure the app to report users rather than ban and remove. This might be useful if you want to get a feel for the accuracy of Bot Bouncer's detections before putting it in full "ban" mode.

## Exempting Users

By default, any bots that you unban are automatically allowlisted and will not be banned again (although this can be turned off).

If you want to preemptively allowlist a user, add the account as an Approved Submitter to your subreddit - Bot Bouncer will never ban approved submitters or moderators.

You can also set a user flair with a CSS class that ends with `proof`. This is so that legacy flairs such as `botbustproof` will prevent a user from being banned.

## Submitting users for review

Subreddit moderators can report the bot from a post or comment's context menu. Choose "Report to /r/BotBouncer".

Otherwise, you can create a link post on [/r/BotBouncer](https://www.reddit.com/r/BotBouncer/) that links to the user's profile. Bot Bouncer will then remove your post and replace it with its own submission for the account, and then the evaluation process will start.

If you feel that you can add extra context to the submission, for example if you have detected bot-like activity that you think may not be obvious, you can create a comment on the new post explaining why the user is a bot. For example a user might look superficially human, but might be copying content from other users. If reporting via the post/comment menu, you will be prompted to optionally add context at this point.

Also, consider **reporting the account**. Bot accounts should be reported to Reddit as Spam->Disruptive use of bots or AI. Reddit's spam detection is getting better all the time and in many cases, the bot's account will be shadowbanned immediately.

## Accounts in scope for Bot Bouncer

Bot Bouncer bans any bot that makes automatic comments or posts without being explicitly summoned. This includes LLM karma farming bots, annoying "reply" bots that break Bottiquette, and so on.

Bot Bouncer will not ban useful service bots, such as ones that respond to user commands (e.g. RemindMeBot or stabbot), nor will it add bots that have been added as moderators or approved users, or have a flair with a CSS class ending in `proof`.

Bot Bouncer is not a generic anti-spam or anti-porn app. If someone is promoting a product, service or adult content in a human manner, they are out of scope.

## Dealing with classifications you feel are incorrect

If you think that you've found a bot that's already marked as human, write in to [/r/BotBouncer's modmail](https://www.reddit.com/message/compose/?to=/r/BotBouncer) with details of why you think that this is the case. Sometimes mistakes are made and we rely on assistance to get classifications right.

Users who have been unfairly banned by Bot Bouncer should be encouraged to modmail in to /r/BotBouncer to appeal their ban. Alternatively, you can do this on the user's behalf. While you can unban the user yourself, this only affects the user on your subreddit and does not prevent the user from being banned from other subreddits.

# Change History

## v1.24 (coming soon)

* Fixed erroneous errors referencing no recent posts/comments when reporting users
* Add new evaluator type
* Improved performance (reducing Dev Platform resource usage)
* Improve reliability of banning users already classified as bots when they post or comment
* Add option (disabled by default) to lock posts/comments when the app removes them
* If "Add mod note on classification change" is turned on, a link to the account's tracking post is included on the mod note when banning or unbanning
* Internal changes to support operations on /r/BotBouncer

## v1.23.1

* Bot Bouncer can now accept a moderator invite if it has been accidentally removed from the mod list
* Reduced Dev Platform resource usage
* Internal changes to support operations on /r/BotBouncer

## v1.22.1

* Improve resilience of app if required permissions are accidentally removed from the app's user account
* Reduce false positives on one evaluator
* Action summary (formerly daily digest) can now be sent either daily or weekly on Mondays
* Action summary (formerly daily digest) no longer incorrectly shows deleted users as if they have been unbanned by Bot Bouncer
* Improved performance to reduce compute load on Dev Platform infrastructure
* Improved evaluation capabilities for the Bot Group Advanced evaluator
* Internal changes to support operations on /r/BotBouncer

## v1.21.0

* Faster response to bot classification changes, down from up to ten minutes to up to one minute
* Faster refreshes of bot detection config, down from up to an hour to up to five minutes
* Embolden instruction in default ban message to emphasise contacting /r/BotBouncer
* Internal changes to support operations on /r/BotBouncer

For older versions, please see the [full changelog](https://github.com/fsvreddit/bot-bouncer/blob/main/changelog.md).
