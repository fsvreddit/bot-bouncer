import { Comment, Post, TriggerContext } from "@devvit/public-api";
import { subDays } from "date-fns";
import { EvaluateEditedComment } from "./EvaluateEditedComment.js";
import { UserExtended } from "../extendedDevvit.js";

const mockContext = {} as unknown as TriggerContext;
const evaluatorVariables = {
    "commentedit:regexes": ["EssayFox"],
    "commentedit:commentmaxageindays": 7,
};

const mockUser = {
    createdAt: new Date(),
    commentKarma: 0,
    hasVerifiedEmail: false,
    id: "t2_fake",
    isAdmin: false,
    isGold: false,
    isModerator: false,
    linkKarma: 0,
    nsfw: false,
    username: "fake",
} as UserExtended;

function createHistory (body: string, edited: boolean, createdAt: Date) {
    return [
        {
            id: "t1_fake",
            createdAt,
            edited,
            body,
        } as unknown as Comment,
        {
            id: "t3_fake",
            createdAt,
            edited: false,
        } as unknown as Post,
    ];
}

test("Edited comment that doesn't match regex", () => {
    const history = createHistory("This is a test comment", true, subDays(new Date(), 1));
    const evaluator = new EvaluateEditedComment(mockContext, evaluatorVariables);
    const evaluationResult = evaluator.evaluate(mockUser, history);
    expect(evaluationResult).toBeFalsy();
});

test("Edited comment that matches regex", () => {
    const history = createHistory("This is an EssayFox comment", true, subDays(new Date(), 1));
    const evaluator = new EvaluateEditedComment(mockContext, evaluatorVariables);
    const evaluationResult = evaluator.evaluate(mockUser, history);
    expect(evaluationResult).toBeTruthy();
});

test("Edited comment that matches regex but is too old", () => {
    const history = createHistory("This is an EssayFox comment", true, subDays(new Date(), 8));
    const evaluator = new EvaluateEditedComment(mockContext, evaluatorVariables);
    const evaluationResult = evaluator.evaluate(mockUser, history);
    expect(evaluationResult).toBeFalsy();
});

test("Edited comment that matches regex but is not edited", () => {
    const history = createHistory("This is an EssayFox comment", false, subDays(new Date(), 1));
    const evaluator = new EvaluateEditedComment(mockContext, evaluatorVariables);
    const evaluationResult = evaluator.evaluate(mockUser, history);
    expect(evaluationResult).toBeFalsy();
});
