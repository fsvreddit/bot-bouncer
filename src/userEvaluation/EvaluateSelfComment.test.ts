import { Comment, Post, TriggerContext } from "@devvit/public-api";
import { UserExtended } from "../extendedDevvit.js";
import { EvaluateSelfComment } from "./EvaluateSelfComment.js";
import { subMinutes } from "date-fns";

const mockTriggerContext = {} as unknown as TriggerContext;

const mockUser = {
    id: "t2_fake",
} as unknown as UserExtended;

const variables = {
    "selfcomment:commentmaxminutes": 4,
};

test("User with a self-comment", () => {
    const history = [
        {
            createdAt: new Date(),
            id: "t1_fake",
            authorId: "t2_fake",
            parentId: "t3_fake2",
            subredditName: "FunnyVideos",
            body: "This is a test comment.",
        } as unknown as Comment,
        {
            createdAt: subMinutes(new Date(), 1),
            id: "t3_fake2",
            authorId: "t2_fake",
            subredditName: "FunnyVideos",
            url: "https://i.redd.it/abc123",
        } as unknown as Post,
    ];

    const evaluator = new EvaluateSelfComment(mockTriggerContext, variables);
    const result = evaluator.evaluate(mockUser, history);
    expect(result).toBeTruthy();
});

test("User with a comment on someone else's post", () => {
    const history = [
        {
            createdAt: new Date(),
            id: "t1_fake",
            authorId: "t2_fake",
            parentId: "t3_fake",
            subredditName: "FunnyVideos",
            body: "This is a test comment.",
        } as unknown as Comment,
        {
            createdAt: subMinutes(new Date(), 1),
            id: "t3_fake2",
            authorId: "t2_fake2",
            subredditName: "FunnyVideos",
            url: "https://i.redd.it/abc123",
        } as unknown as Post,
    ];

    const evaluator = new EvaluateSelfComment(mockTriggerContext, variables);
    const result = evaluator.evaluate(mockUser, history);
    expect(result).toBeFalsy();
});
