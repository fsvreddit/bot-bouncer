# Bot Bouncer

Bot Bouncer is a Dev Platform app that bans bots and other harmful accounts from subreddits that use it. It is heavily inspired by BotDefense, which wrapped up operations in 2023.

Bots are classified via submissions on /r/BotBouncer, via a mix of automated and human classification.

If you add Bot Bouncer to your sub via the Dev Platform app directory, it will watch for all new submissions and comments from users, and if the account is classified as a bot by the app, it will be banned.

## How do I add Bot Bouncer?

Bot Bouncer can be installed from the Dev Platform app directory [here](https://developers.reddit.com/apps/bot-bouncer). Please do not try and invite the app to your sub through the moderators list.

## How do I submit a bot for review?

First, I recommend **reporting the account**. Bot accounts should be reported to Reddit as Spam->Harmful use of bots or AI. Reddit's spam detection is getting better all the time and in many cases, the bot's account will be shadowbanned immediately.

If that does not happen, create a submission on /r/BotBouncer linking to the user's profile. Bot Bouncer will then remove your post and replace it with its own submission for the account, and then the evaluation process will start.

If you feel that you can add extra context to the submission, for example if you have detected bot-like activity that you think may not be obvious, you can add body text to the submission that is created by the bot to help evaluation. For example a user might look superficially human, but might be copying content from other users.

You do not need to moderate a subreddit to submit an account to BotBouncer. However if you are, there is a menu item on posts and comments on subreddits you moderate that have the app installed that can be used to automatically submit the account for consideration.

## How do I whitelist a user?

The easiest way is to add the account as an Approved Submitter to your subreddit - Bot Bouncer will never ban approved submitters or moderators.

You can also set a user flair with a CSS class that ends with `proof`. This is so that legacy flairs such as `botbustproof` will automatically whitelist the user.

## What kind of accounts get banned by Bot Bouncer?

Bot Bouncer bans any bot that makes automatic comments or posts without being explicitly summoned. This includes LLM karma farming bots, annoying "reply" bots that break Bottiquette, and so on.

Bot Bouncer will not ban useful service bots, such as ones that respond to user commands (e.g. RemindMeBot or stabbot), nor will it add bots that have been added as moderators or approved users, or have a flair with a CSS class ending in `proof`.

## I've been banned by Bot Bouncer. How do I contest this?

Write in to /r/BotBouncer's modmail. Your account status will be reviewed and if you are deemed human, you will be unbanned from any subreddit that Bot Bouncer banned you in.

## I think an account that was classified as human is actually a harmful bot. What should I do?

Write in to /r/BotBouncer's modmail with details of why you think that this is the case. Sometimes mistakes are made and we rely on assistance to get classifications right.

## How can I help you out?

The best way is to submit any bots you find in the wild. However if you have a track record of moderation experience and think you can also help classify accounts, I want to hear from you! Please write in to /r/BotBouncer modmail and we'll talk!
