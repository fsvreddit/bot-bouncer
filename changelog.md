# Changelog for Bot Bouncer

## v1.22.1

* Improve resilience of app if required permissions are accidentally removed from the app's user account
* Reduce false positives on one evaluator
* Action summary (formerly daily digest) can now be sent either daily or weekly on Mondays
* Action summary (formerly daily digest) no longer incorrectly shows deleted users as if they have been unbanned by Bot Bouncer
* Improved performance to reduce compute load on Dev Platform infrastructure
* Internal changes to support operations on /r/BotBouncer

## v1.21.0

* Faster response to bot classification changes, down from up to ten minutes to up to one minute
* Faster refreshes of bot detection config, down from up to an hour to up to five minutes
* Embolden instruction in default ban message to emphasise contacting /r/BotBouncer
* Internal changes to support operations on /r/BotBouncer

## v1.20.0

* Reduce false positives on two evaluator types
* Flexible rules-based evaluator can now act on comment edits
* Notify mod teams via Modmail if /u/bot-bouncer is removed from the mod list without properly uninstalling
* Internal changes to support operations on /r/BotBouncer

## v1.19.1

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

## v1.14.0

* Prevent duplicate private mod notes from being created in Modmail when a user who is marked as banned writes in
* Add option to report posts/comments rather than ban users detected as bots, which could be useful for subreddits wary of the accuracy of Bot Bouncer listings
* Improve accuracy of Soccer/Movie streams evaluator
* Reduce false positives on inconsistent account age/gender evaluators

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
