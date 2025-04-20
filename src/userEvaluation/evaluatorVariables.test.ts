import { invalidEvaluatorVariableCondition, yamlToVariables } from "./evaluatorVariables.js";

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

test("Invalid regex", () => {
    const variables = {
        "biotext:bantext": [
            "(?:addison|adele|allie",
        ],
    };

    const result = invalidEvaluatorVariableCondition(variables);
    expect(result.length).toBe(1);
});

test("Regex with || condition", () => {
    const variables = {
        "biotext:bantext": [
            "(?:addison|adele||allie)",
        ],
    };

    const result = invalidEvaluatorVariableCondition(variables);
    expect(result.length).toBe(1);
    console.log(result);
});

test("Regex with badly formed array", () => {
    const variables = {
        "randommodule:thing": [
            "(?:addison|adele|allie)",
            {
                threshold: 1,
                value: "test",
            },
        ],
    };

    const result = invalidEvaluatorVariableCondition(variables);
    expect(result.length).toBe(1);
});
