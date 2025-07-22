# Changelog for Bot Bouncer

## v1.15.0

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

For older versions, please see the [full changelog](https://github.com/fsvreddit/bot-bouncer/blob/main/changelog.md).
