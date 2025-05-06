import { Post, TriggerContext } from "@devvit/public-api";
import { EvaluateBotGroup } from "./EvaluateBotGroup.js";
import { yamlToVariables } from "./evaluatorVariables.js";
import { UserExtended } from "../extendedDevvit.js";

const yaml = `
name: botgroup
killswitch: false

group1:
    name: AccidentalSlapstick Group
    dateFrom: 2022-05-01
    dateTo: 2022-05-02
    usernameRegex: '^(?:[A-Z][a-z]+){2}$'
    subreddits:
        - AccidentalSlapstick
`;

const mockUser: UserExtended = {
    username: "BriannaCherries",
    createdAt: new Date(1651386630000),
} as unknown as UserExtended;

function createMockHistory (subreddits: string[]): Post[] {
    return subreddits.map(subreddit => ({
        subredditName: subreddit,
        createdAt: new Date(),
        authorName: "BriannaCherries",
        id: `t3_${subreddit}`,
        title: "Test Post",
        body: "Test Body",
    } as unknown as Post));
}

test("Ensure that bot groups are parsed correctly", () => {
    const variables = yamlToVariables(yaml);
    const evaluator = new EvaluateBotGroup({} as unknown as TriggerContext, variables);
    const botGroups = evaluator.getBotGroups();
    expect(botGroups.length).toBe(1);
});

test("User with matching user properties and history", () => {
    const variables = yamlToVariables(yaml);
    const evaluator = new EvaluateBotGroup({} as unknown as TriggerContext, variables);
    const preEvaluateResult = evaluator.preEvaluateUser(mockUser);
    expect(preEvaluateResult).toBe(true);

    const history = createMockHistory(["AccidentalSlapstick"]);
    const result = evaluator.evaluate(mockUser, history);
    expect(result).toBe(true);
});

test("Invalid bot group - bad regex", () => {
    const yaml = `
name: botgroup
killswitch: false

group1:
    name: AccidentalSlapstick Group
    dateFrom: 2022-05-01
    dateTo: 2022-05-02
    usernameRegex: '['
    subreddits:
        - AccidentalSlapstick
`;

    const variables = yamlToVariables(yaml);
    const evaluator = new EvaluateBotGroup({} as unknown as TriggerContext, variables);
    const errors = evaluator.validateVariables();
    console.log(errors);
    expect(errors.length).toBe(1);
});

test("Invalid bot group - bad date", () => {
    const yaml = `
name: botgroup
killswitch: false

group1:
    name: AccidentalSlapstick Group
    dateFrom: 2022-05-01
    dateTo: 22-5-02
    usernameRegex: '^(?:[A-Z][a-z]+){2}$'
    subreddits:
        - AccidentalSlapstick
`;

    const variables = yamlToVariables(yaml);
    const evaluator = new EvaluateBotGroup({} as unknown as TriggerContext, variables);
    const errors = evaluator.validateVariables();
    console.log(errors);
    expect(errors.length).toBe(1);
});
