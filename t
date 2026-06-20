[1mdiff --git a/src/modmail/evaluatorReversals.ts b/src/modmail/evaluatorReversals.ts[m
[1mindex 73815b9..12b55e1 100644[m
[1m--- a/src/modmail/evaluatorReversals.ts[m
[1m+++ b/src/modmail/evaluatorReversals.ts[m
[36m@@ -287,11 +287,8 @@[m [mexport async function reversePostCreationQueue (event: ScheduledJobEvent<JSONObj[m
         }[m
 [m
         // Reversible.[m
[31m-        const txn = await context.redis.watch();[m
[31m-        await txn.multi();[m
[31m-        await txn.zRem(SUBMISSION_QUEUE, [username]);[m
[31m-        await txn.hDel(SUBMISSION_DETAILS, [username]);[m
[31m-        await txn.exec();[m
[32m+[m[32m        await context.redis.zRem(SUBMISSION_QUEUE, [username]);[m
[32m+[m[32m        await context.redis.hDel(SUBMISSION_DETAILS, [username]);[m
         await deleteAccountInitialEvaluationResults(username, context);[m
         console.log(`Evaluator Reversals: Removed ${username} from the post creation queue.`);[m
         reversedTotal++;[m
[36m@@ -337,11 +334,8 @@[m [mexport async function deleteRecordsForRemovedUsers (_: unknown, context: JobCont[m
             continue;[m
         }[m
 [m
[31m-        const txn = await context.redis.watch();[m
[31m-        await txn.multi();[m
[31m-        await updateAggregate(userStatus.userStatus, -1, txn);[m
[31m-        await txn.zRem(CLEANUP_LOG_KEY, [username]);[m
[31m-        await txn.exec();[m
[32m+[m[32m        await updateAggregate(userStatus.userStatus, -1, context.redis);[m
[32m+[m[32m        await context.redis.zRem(CLEANUP_LOG_KEY, [username]);[m
 [m
         await deleteUserStatus(username, context);[m
 [m
