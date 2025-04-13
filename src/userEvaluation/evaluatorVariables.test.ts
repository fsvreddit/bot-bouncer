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
