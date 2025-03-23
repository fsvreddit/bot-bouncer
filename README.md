Bot Bouncer is a Dev Platform app that bans bots and other harmful accounts from subreddits that use it. It is heavily inspired by BotDefense, which wrapped up operations in 2023.

Bots are classified via submissions on [/r/BotBouncer](https://www.reddit.com/r/BotBouncer/), via a mix of automated and human classification.

If you add Bot Bouncer to your sub via the Dev Platform app directory, it will watch for all new submissions and comments from users, and if the account is classified as a bot by the app, it will be banned.

Bot Bouncer is open source. You can find the source code on GitHub [here](https://github.com/fsvreddit/bot-bouncer).

## How do I submit a bot for review?

First, I recommend **reporting the account**. Bot accounts should be reported to Reddit as Spam->Harmful use of bots or AI. Reddit's spam detection is getting better all the time and in many cases, the bot's account will be shadowbanned immediately.

If that does not happen, submit the bot to [/r/BotBouncer](https://www.reddit.com/r/BotBouncer/). This can be done in one of two ways:

* If you are a subreddit moderator, you can report the bot from a post or comment's context menu. Choose "Report to /r/BotBouncer".
* Otherwise, you can create a link post on [/r/BotBouncer](https://www.reddit.com/r/BotBouncer/) that links to the user's profile. Bot Bouncer will then remove your post and replace it with its own submission for the account, and then the evaluation process will start.

If you feel that you can add extra context to the submission, for example if you have detected bot-like activity that you think may not be obvious, you can create a comment on the new post explaining why the user is a bot. For example a user might look superficially human, but might be copying content from other users. If reporting via the post/comment menu, you will be prompted to optionally add context at this point.

## At what point are bots banned?

If a user creates a post or comment on your subreddit and the user is classified as a bot already, the post or comment will be removed immediately and the user banned.

Optionally, if you have turned on the "Ban and remove recent content" option configured, newly classified bots will be banned if they have posted or commented on your subreddit within the past week shortly after being classified.

## How do I exempt (allowlist) a user?

The easiest way is to add the account as an Approved Submitter to your subreddit - Bot Bouncer will never ban approved submitters or moderators.

You can also set a user flair with a CSS class that ends with `proof`. This is so that legacy flairs such as `botbustproof` will prevent a user from being banned.

## What kind of accounts get banned by Bot Bouncer?

Bot Bouncer bans any bot that makes automatic comments or posts without being explicitly summoned. This includes LLM karma farming bots, annoying "reply" bots that break Bottiquette, and so on.

Bot Bouncer will not ban useful service bots, such as ones that respond to user commands (e.g. RemindMeBot or stabbot), nor will it add bots that have been added as moderators or approved users, or have a flair with a CSS class ending in `proof`.

## What modmail features are supported?

If a user that has been banned by Bot Bouncer writes in to your subreddit, Bot Bouncer will add a private mod note to the modmail thread that links to the submission on [/r/BotBouncer](https://www.reddit.com/r/BotBouncer/), and recommending that the user appeals via /r/BotBouncer. This is to save time appealing from all subreddits that the user has been banned from.

## I think an account that was classified as human is actually a harmful bot. What should I do?

Write in to [/r/BotBouncer's modmail](https://www.reddit.com/message/compose/?to=/r/BotBouncer) with details of why you think that this is the case. Sometimes mistakes are made and we rely on assistance to get classifications right.

# Change History

## Next

Note: v1.6.1 is the current public release. An upgrade may appear to be available but not be installable.

* Fix bug that prevented auto allowlisting on unban from working properly
* Add new opt-in upgrade notification system. If you would like to be notified of new upgrades, you can do it from the app settings page.
* Add new opt-in feature to send a daily digest of bot detections and bans
* Removed four redundant evaluators for bot styles no longer seen in the wild
* Add new evaluator for posts that match certain title patterns
* Add new evaluator for short top level comments in certain scenarios
* No longer link to comment/post that triggers a ban for bots to avoid user confusion
* Performance improvements

## v1.6.1

* Prevent items that were removed by Reddit, Automod or a subreddit moderator from being reinstated if an account is reclassified as human
* Add option to make the "extra information" about a submission private
* Improve sticky post evaluator to evaluate on all subs using Bot Bouncer, not just r/BotBouncer itself
* Changes to support internal r/BotBouncer operations

## v1.5.2

* Changes to support internal r/BotBouncer operations
* Add new evaluator for bot rings that have identical sticky posts on their profiles
* Add new evaluator for bots that are shilling specific services with mentions in every comment
* Add new evaluator for bots that advertise illegal IPTV streams across multiple subreddits

## v1.4.0

* Fully reinstate content removed by bot when a user is marked as human
* Fixed a bug that could result in Bot Bouncer approving a post or comment that had been removed by a mod or Automod
* Reduce false positives on one evaluator
* Add new evaluator for a class of bot seen on some motivational subreddits

## v1.3.0

* Add feature to disable "zombie" evaluator if needed
* Add evaluator for suspect username patterns
* Improved message sent to users making appeals
* Allow certain domains to result in an automatic ban evaluation
* Internal improvements to reduce the chance of duplicate submissions

## v1.2.0

* Changes to support operations on r/BotBouncer
* Add evaluator for affiliate spam
* Prevent reapproval of comments for accounts set to "organic" if they were filtered or removed by Automod, Reddit or a mod

## v1.1.0

* The "CQS Tester" evaluator now checks a wider range of post titles
* Terminology changed from "whitelist" to "allowlist" or similar throughout user interfaces and documentation
* Introduced a new automated bot detector
* Fixed a bug that prevents unbans from being processed correctly after a user is set from "banned" to "organic"
