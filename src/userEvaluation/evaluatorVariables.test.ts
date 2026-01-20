import { yamlToVariables } from "@fsvreddit/bot-bouncer-evaluation";
import { invalidEvaluatorVariableCondition } from "./evaluatorVariables.js";
import { JobContext } from "@devvit/public-api";

test("Parsing YAML", () => {
    const yamlString = `
name: biotext

maxageweeks: 24
---
name: short-nontlc
regexes:
    - a
    - b
---

---
`;

    const variables = yamlToVariables(yamlString);
    expect(variables["biotext:maxageweeks"]).toBe(24);
    expect(variables["short-nontlc:regexes"]).toEqual(["a", "b"]);
});

test("Text Substitution", () => {
    const yamlString = `
name: substitutions

namestems: addison|adele|allie
badhandles: vanswoods|vidahsq
---
name: badusername
regexes: (?:{{namestems}})
---
name: badusername2
regexes:
    - (?:{{namestems}})
    - (?:{{badhandles}})
    - boop
`;

    const variables = yamlToVariables(yamlString);
    expect(variables["badusername:regexes"]).toBe("(?:addison|adele|allie)");
    expect(variables["badusername2:regexes"]).toEqual([
        "(?:addison|adele|allie)",
        "(?:vanswoods|vidahsq)",
        "boop",
    ]);
});

test("Invalid regex", async () => {
    const variables = {
        "biotext:bantext": [
            "(?:addison|adele|allie",
        ],
    };

    const result = await invalidEvaluatorVariableCondition(variables, {} as unknown as JobContext);
    expect(result.length).toBe(1);
});

test("Regex with || condition", async () => {
    const variables = {
        "biotext:bantext": [
            "(?:addison|adele||allie)",
        ],
    };

    const result = await invalidEvaluatorVariableCondition(variables, {} as unknown as JobContext);
    expect(result.length).toBe(1);
    console.log(result);
});

test("Regex with badly formed array", async () => {
    const variables = {
        "randommodule:thing": [
            "(?:addison|adele|allie)",
            {
                threshold: 1,
                value: "test",
            },
        ],
    };

    const result = await invalidEvaluatorVariableCondition(variables, {} as unknown as JobContext);
    expect(result.length).toBe(1);
});

test("Bot Groups test", async () => {
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
    const variables = yamlToVariables(yaml);
    const results = await invalidEvaluatorVariableCondition(variables, {} as unknown as JobContext);
    expect(results.length).toBe(0);
});
