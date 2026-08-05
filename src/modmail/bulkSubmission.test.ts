import { AccountReviewScheduleResult } from "./accountReview.js";
import { buildScheduleReviewReply } from "./bulkSubmission.js";

test("buildScheduleReviewReply reports scheduled reviews with correct grammar", () => {
    expect(buildScheduleReviewReply([
        {
            username: "ExampleUser",
            result: AccountReviewScheduleResult.Scheduled,
        },
    ], 2)).toEqual([
        {
            p: "Scheduled 1 account review in 2 days.",
        },
    ]);
});

test("buildScheduleReviewReply explains skipped accounts", () => {
    expect(buildScheduleReviewReply([
        {
            username: "ScheduledUser",
            result: AccountReviewScheduleResult.Scheduled,
        },
        {
            username: "UnknownUser",
            result: AccountReviewScheduleResult.UserNotFound,
        },
        {
            username: "MissingPost",
            result: AccountReviewScheduleResult.MissingTrackingPost,
        },
    ], 1)).toEqual([
        {
            p: "Scheduled 1 account review in 1 day.",
        },
        {
            p: "Skipped 2 accounts:",
        },
        {
            ul: [
                "/u/UnknownUser: no existing Bot Bouncer status was found",
                "/u/MissingPost: no tracking post was available",
            ],
        },
    ]);
});

test("buildScheduleReviewReply handles a request with no schedulable accounts", () => {
    expect(buildScheduleReviewReply([
        {
            username: "UnknownUser",
            result: AccountReviewScheduleResult.UserNotFound,
        },
    ], 7)).toEqual([
        {
            p: "Scheduled 0 account reviews in 7 days.",
        },
        {
            p: "Skipped 1 account:",
        },
        {
            ul: [
                "/u/UnknownUser: no existing Bot Bouncer status was found",
            ],
        },
    ]);
});
