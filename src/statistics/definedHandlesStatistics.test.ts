import { getHandlesFromRegex } from "./definedHandlesStatistics.js";

test("Defined Handles Splitting", () => {
    const input = "handle1|(?:handle2|handle2)|handle3";
    const expected = ["handle1", "(?:handle2|handle2)", "handle3"];
    const result = getHandlesFromRegex(input);
    expect(result).toEqual(expected);
});
