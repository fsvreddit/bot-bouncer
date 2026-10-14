import { vi } from "vitest";

vi.hoisted(() => {
    // @fsvreddit/fsv-devvit-web-helpers calls getDevvitConfig() at module level inside
    // @fsvreddit/bot-bouncer-evaluation's CJS require chain, which Vitest cannot intercept.
    // Stub the global so the module loads without throwing.
    globalThis.devvit = { config: {} };
});

vi.mock("@devvit/web/server", () => ({
    context: {},
    reddit: {},
    redis: {},
    scheduler: {},
}));

vi.mock("@fsvreddit/fsv-devvit-web-helpers", () => ({
    getUserExtended: vi.fn(),
    hasTriggerBeenHandled: vi.fn(),
}));

import { yamlToVariables } from "@fsvreddit/bot-bouncer-evaluation";
import { runWithContext } from "@devvit/server";
import { invalidEvaluatorVariableCondition } from "./evaluatorVariables.js";
import { expect, test } from "vitest";

test("Parsing YAML", () => {
    const yamlString = `
name: biotext
killswitch: false

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
killswitch: false

regexes: (?:{{namestems}})
---
name: badusername2
killswitch: false

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
        "biotext:killswitch": false,
        "biotext:bantext": [
            "(?:addison|adele|allie",
        ],
    };

    const result = await runWithContext({ appSlug: "test" }, () => invalidEvaluatorVariableCondition(variables, true));
    expect(result.length).toBe(1);
});

test("Regex with || condition", async () => {
    const variables = {
        "biotext:killswitch": false,
        "biotext:bantext": [
            "(?:addison|adele||allie)",
        ],
    };

    const result = await runWithContext({ appSlug: "test" }, () => invalidEvaluatorVariableCondition(variables, true));
    expect(result.length).toBe(1);
});

test("Regex with badly formed array", async () => {
    const variables = {
        "randommodule:killswitch": false,
        "randommodule:thing": [
            "(?:addison|adele|allie)",
            {
                threshold: 1,
                value: "test",
            },
        ],
    };

    const result = await runWithContext({ appSlug: "test" }, () => invalidEvaluatorVariableCondition(variables, true));
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
    const results = await runWithContext({ appSlug: "test" }, () => invalidEvaluatorVariableCondition(variables, true));
    expect(results.length).toBe(0);
});
