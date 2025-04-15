import { yamlToVariables } from "./evaluatorVariables.js";

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
