Bot Bouncer is a Dev Platform app that bans bots and other harmful accounts from subreddits that use it. It is heavily inspired by BotDefense, which wrapped up operations in 2023.

Bots are classified via submissions on [/r/BotBouncer](https://www.reddit.com/r/BotBouncer/), via a mix of automated and human classification.

If you add Bot Bouncer to your sub via the Dev Platform app directory, it will watch for all new submissions and comments from users, and if the account is classified as a bot by the app, it will be banned.

Bot Bouncer is open source. You can find the source code on GitHub [here](https://github.com/fsvreddit/bot-bouncer).

## At what point are bots banned?

If a user creates a post or comment on your subreddit and the user is classified as a bot already, the post or comment will be removed immediately and the user banned.

Optionally, if you have turned on the "Ban and remove recent content" option configured, newly classified bots will be banned if they have posted or commented on your subreddit within the past week shortly after being classified.

## How do I exempt (allowlist) a user?

The easiest way is to add the account as an Approved Submitter to your subreddit - Bot Bouncer will never ban approved submitters or moderators.

You can also set a user flair with a CSS class that ends with `proof`. This is so that legacy flairs such as `botbustproof` will prevent a user from being banned.

By default, any bots that you unban are automatically allowlisted and will not be banned again (although this can be turned off).

## How do I submit a bot for review?

First, I recommend **reporting the account**. Bot accounts should be reported to Reddit as Spam->Harmful use of bots or AI. Reddit's spam detection is getting better all the time and in many cases, the bot's account will be shadowbanned immediately.

If that does not happen, submit the bot to [/r/BotBouncer](https://www.reddit.com/r/BotBouncer/). This can be done in one of two ways:

* If you are a subreddit moderator, you can report the bot from a post or comment's context menu. Choose "Report to /r/BotBouncer".
* Otherwise, you can create a link post on [/r/BotBouncer](https://www.reddit.com/r/BotBouncer/) that links to the user's profile. Bot Bouncer will then remove your post and replace it with its own submission for the account, and then the evaluation process will start.

If you feel that you can add extra context to the submission, for example if you have detected bot-like activity that you think may not be obvious, you can create a comment on the new post explaining why the user is a bot. For example a user might look superficially human, but might be copying content from other users. If reporting via the post/comment menu, you will be prompted to optionally add context at this point.

## What kind of accounts get banned by Bot Bouncer?

Bot Bouncer bans any bot that makes automatic comments or posts without being explicitly summoned. This includes LLM karma farming bots, annoying "reply" bots that break Bottiquette, and so on.

Bot Bouncer will not ban useful service bots, such as ones that respond to user commands (e.g. RemindMeBot or stabbot), nor will it add bots that have been added as moderators or approved users, or have a flair with a CSS class ending in `proof`.

## Modmail Features

If a user that has been banned by Bot Bouncer writes in to your subreddit, Bot Bouncer will add a private mod note to the modmail thread that links to the submission on [/r/BotBouncer](https://www.reddit.com/r/BotBouncer/), and recommending that the user appeals via /r/BotBouncer. This is to save time appealing from all subreddits that the user has been banned from.

## I think an account that was classified as human is actually a harmful bot. What should I do?

Write in to [/r/BotBouncer's modmail](https://www.reddit.com/message/compose/?to=/r/BotBouncer) with details of why you think that this is the case. Sometimes mistakes are made and we rely on assistance to get classifications right.

# Change History

## Next

* Add option to report posts/comments rather than ban users detected as bots, which could be useful for subreddits wary of the accuracy of Bot Bouncer listings
* Prevent duplicate private mod notes from being created in Modmail when a user who is marked as banned writes in

## v1.13.11

* Improve reliability of processing unbans after successful appeals
* Internal changes to support operations on /r/BotBouncer

## v1.13.0

* Improve user interface for reporting bots
* Improve reliability of unbanning users following a reclassification
* Add new evaluator for a specific NSFW bot behaviour
* Internal changes to support operations on /r/BotBouncer

## v1.12.0

* Make daily digest fully configurable
* Remove NSFW check on Social Links evaluator
* Add new evaluator for Telegram group spam
* Add new evaluator for spam comments used by future adult content creation accounts being farmed
* Internal changes to support operations on /r/BotBouncer

## v1.11.0

* Add new evaluator for Amazon affiliate spam
* Add new evaluator to find accounts whose first posts are advertising certain products or services
* Auto-report users banned from a sub using Bot Bouncer with a reason that implies bot activity
* Fixed a bug that resulted in posts and comments that had already been spammed by mods to be removed as not spam
* When attempting to report a post from a context menu, the current status (if any) is displayed.
* Prevent accidental reporting of subreddit moderators
* Internal changes to support operations on /r/BotBouncer

## v1.10.0

* Add ability for mods submitting accounts manually to receive feedback on the account's classification
* Reduce false positives on one evaluator
* Remove "bot mentions" feature due to low numbers of bot detections
* Daily digest now includes details of users who were unbanned
* Add new evaluator for users with suspicious history in unrelated geosubs
* Add new evaluator for very specific bot groups
* Add new evaluator for rapid fire comment or post creation
* Remove evaluators for bot types that are no longer in operation
* Internal changes to support operations on /r/BotBouncer

## v1.9.1

* When a bot is detected, posts and comments that were modqueued are now removed.
* Reduce false positives on one bot evaluator
* Add new evaluator for obfuscated bio keywords
* Add new evaluator for suspect social links
* Add new evaluator for suspicious first posts
* Add new evaluators for OnlyFans bots with specific characteristics
* Add new evaluator for edited comments that match certain characteristics
* Add new evaluator for NSFW accounts with inconsistent ages in their very recent post titles
* Add new evaluator for NSFW accounts with inconsistent genders in post titles (e.g. a mix of M4F, F4M etc.), with an exception for accounts marked as being a shared or couples account
* Add new evaluator for accounts with specific display name characteristics
* Add new evaluator for bots building karma for likely future adult content promoters
* Removed evaluators for bot styles that appear to have been retired
* Remove Honeypot mode (some subs were enabling this inadvertently)
* Internal changes to support operations on /r/BotBouncer

## v1.7.0

* Fix bug that prevented auto allowlisting on unban from working properly
* Fix bug where Bot Bouncer might resurface posts that had been previously removed by a moderator, Automod or Reddit
* Add new opt-in upgrade notification system. If you would like to be notified of new upgrades, you can do it from the app settings page.
* Add new opt-in feature to send a daily digest of bot detections and bans
* Removed four redundant evaluators for bot styles no longer seen in the wild
* Add new evaluator for posts that match certain title patterns
* Add new evaluator for short top level comments in certain scenarios
* Add new evaluator for users with bio text that matches certain patterns
* No longer link to comment/post that triggers a ban for bots to avoid user confusion
* Add "honeypot mode" for unusual subs that may want to report potential bots but not take action on the sub itself
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
