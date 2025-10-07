Bot Bouncer is a Dev Platform app that bans bots and other harmful accounts from subreddits that use it. It is heavily inspired by BotDefense, which wrapped up operations in 2023.

Bots are classified via submissions on [/r/BotBouncer](https://www.reddit.com/r/BotBouncer/), via a mix of automated and human classification.

If you add Bot Bouncer to your sub via the Dev Platform app directory, it will watch for all new submissions and comments from users, and if the account is classified as a bot by the app, it will be banned.

Bot Bouncer is open source. You can find the source code on GitHub [here](https://github.com/fsvreddit/bot-bouncer).

## At what point are bots banned?

If a user creates a post or comment on your subreddit and the user is classified as a bot already, the post or comment will be removed immediately and the user banned.

Optionally, if you have turned on the "Ban and remove recent content" option configured, newly classified bots will be banned if they have posted or commented on your subreddit within the past week shortly after being classified.

Mods can choose to configure the app to report users rather than ban and remove. This might be useful if you want to get a feel for the accuracy of Bot Bouncer's detections before putting it in full "ban" mode.

## How do I exempt (allowlist) a user?

By default, any bots that you unban are automatically allowlisted and will not be banned again (although this can be turned off).

If you want to preemptively allowlist a user, add the account as an Approved Submitter to your subreddit - Bot Bouncer will never ban approved submitters or moderators.

You can also set a user flair with a CSS class that ends with `proof`. This is so that legacy flairs such as `botbustproof` will prevent a user from being banned.

## How do I submit a bot for review?

* If you are a subreddit moderator, you can report the bot from a post or comment's context menu. Choose "Report to /r/BotBouncer".
* Otherwise, you can create a link post on [/r/BotBouncer](https://www.reddit.com/r/BotBouncer/) that links to the user's profile. Bot Bouncer will then remove your post and replace it with its own submission for the account, and then the evaluation process will start.

If you feel that you can add extra context to the submission, for example if you have detected bot-like activity that you think may not be obvious, you can create a comment on the new post explaining why the user is a bot. For example a user might look superficially human, but might be copying content from other users. If reporting via the post/comment menu, you will be prompted to optionally add context at this point.

Also, consider **reporting the account**. Bot accounts should be reported to Reddit as Spam->Disruptive use of bots or AI. Reddit's spam detection is getting better all the time and in many cases, the bot's account will be shadowbanned immediately.

## What kind of accounts get banned by Bot Bouncer?

Bot Bouncer bans any bot that makes automatic comments or posts without being explicitly summoned. This includes LLM karma farming bots, annoying "reply" bots that break Bottiquette, and so on.

Bot Bouncer will not ban useful service bots, such as ones that respond to user commands (e.g. RemindMeBot or stabbot), nor will it add bots that have been added as moderators or approved users, or have a flair with a CSS class ending in `proof`.

Bot Bouncer is not a generic anti-spam or anti-porn app. If someone is promoting a product, service or adult content in a human manner, they are out of scope.

## Modmail Features

If a user that has been banned by Bot Bouncer writes in to your subreddit, Bot Bouncer will add a private mod note to the modmail thread that links to the submission on [/r/BotBouncer](https://www.reddit.com/r/BotBouncer/), and recommending that the user appeals via /r/BotBouncer. This is to save time appealing from all subreddits that the user has been banned from.

## I think an account that was classified as human is actually a harmful bot. What should I do?

Write in to [/r/BotBouncer's modmail](https://www.reddit.com/message/compose/?to=/r/BotBouncer) with details of why you think that this is the case. Sometimes mistakes are made and we rely on assistance to get classifications right.

## I think an account that was classified as a bot is a real person, what should I do?

If the user has contacted you directly, encourage them to modmail in to /r/BotBouncer to appeal their ban. Alternatively, you can do this on the user's behalf. Sometimes mistakes are made and we rely on assistance to get classifications right.

While you can unban the user yourself, this only affects the user on your subreddit and does not prevent the user from being banned from other subreddits.

# Change History

## Next version (coming soon)

* Fix typo on default appeal message that users are prompted to send
* Add feature to query a user's classification status when reporting, if they are marked as human
* Internal changes to support operations on /r/BotBouncer

## v1.18.0

* Fix issues that could result in ban appeals not being processed on subreddits using Bot Bouncer
* Add option to add a mod note on accounts banned by Bot Bouncer
* Pre-populate appeal message with a placeholder message (thanks, /u/Drunken_Economist!)
* Enhance Bad Social Links evaluator to look at links on posts, not just social links in profile
* Internal changes to support operations on /r/BotBouncer

## v1.17.15

* Fix issues that could result in allowlisted users being reported/banned in some situations
* Internal changes to support operations on /r/BotBouncer

## v1.17.2

* Fix issues that could result in allowlisted users being reported/banned in some situations
* Disable "receive feedback" checkbox on report form if Bot Bouncer has failed to send messages several times, with user feedback to check settings.
* Remove five obsolete evaluators
* Improve efficiency of account evaluation code
* Performance improvements to reduce Dev Platform resource usage
* Internal changes to support operations on /r/BotBouncer

## v1.16.1

* Refresh evaluator configuration more frequently to improve detection accuracy
* Fixed a bug that could cause errors banning newly detected users
* Remove disabled features including one redundant evaluator
* Add configuration setting to file daily digests in the Mod Notifications section of modmail if preferred
* Prevent "this user is listed on /r/BotBouncer" modmail notes on bans from other bots such as Hive Protector or SafestBot
* Internal changes to support operations on /r/BotBouncer

## v1.15.50

* Fix typo on settings screen
* Bug fixes to new flexible evaluator to improve accuracy
* Internal changes to support operations on /r/BotBouncer

## v1.15.3

* Don't reinstate content that had reports at the point of ban if a user is marked as human on appeal
* Reduce false positives on Inconsistent Age evaluator
* Introduces new flexible evaluator type to catch more styles of bots without redeploying app
* Retire two evaluator types for bot types not seen in a long while
* Internal changes to support operations on /r/BotBouncer

For older versions, please see the [full changelog](https://github.com/fsvreddit/bot-bouncer/blob/main/changelog.md).
